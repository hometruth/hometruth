/** HomeKit H.264 live video. Media URLs and keys remain on the private IPC channel. */
import { CameraController, DoorbellController } from '@homebridge/hap-nodejs';
import { createSocket } from 'node:dgram';
import { isIP } from 'node:net';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

export function cameraController(item, request) {
  const sessions = new Map();
  const stop = id => {
    const session = sessions.get(id); if (!session) return;
    sessions.delete(id); clearTimeout(session.timeout);
    try { session.socket?.close(); } catch {}
    session.process?.kill('SIGTERM');
    if (session.process) setTimeout(() => { if (session.process.exitCode === null) session.process.kill('SIGKILL'); }, 1000).unref();
  };
  const delegate = {
    handleSnapshotRequest({ width, height }, callback) {
      request('snapshot', { accessory: item.id }).then(data => resizeSnapshot(Buffer.from(data, 'base64'), width, height)).then(data => callback(undefined, data), () => callback(new Error('Camera snapshot unavailable')));
    },
    prepareStream(input, callback) {
      if (!isIP(input.targetAddress) || input.video.srtpCryptoSuite !== 0 || sessions.size >= 2) { callback(new Error('Unsupported camera session')); return; }
      stop(input.sessionID);
      const socket = createSocket(input.addressVersion === 'ipv6' ? 'udp6' : 'udp4');
      const session = { input, socket, ssrc: randomBytes(4).readUInt32BE(0), timeout: setTimeout(() => stop(input.sessionID), 30000) };
      sessions.set(input.sessionID, session);
      socket.once('error', () => { stop(input.sessionID); callback(new Error('Camera port unavailable')); });
      socket.bind(0, input.sourceAddress, () => {
        session.port = socket.address().port;
        callback(undefined, { video: { port: session.port, ssrc: session.ssrc, srtp_key: input.video.srtp_key, srtp_salt: input.video.srtp_salt } });
      });
    },
    handleStreamRequest(input, callback) {
      const session = sessions.get(input.sessionID);
      if (input.type === 'stop') { stop(input.sessionID); callback(); return; }
      if (!session) { callback(new Error('Camera session expired')); return; }
      if (input.type === 'reconfigure') { callback(new Error('Start a new session to change video quality')); return; }
      request('media', { accessory: item.id }).then(uri => {
        if (!sessions.has(input.sessionID)) throw new Error('Camera session ended');
        const v = input.video;
        if (![v.width,v.height,v.fps,v.max_bit_rate,v.pt,v.mtu,session.input.video.port].every(Number.isFinite)) throw new Error('Invalid video parameters');
        session.socket.close(); session.socket = undefined; clearTimeout(session.timeout);
        const peer = session.input.targetAddress.includes(':') ? `[${session.input.targetAddress}]` : session.input.targetAddress;
        const key = Buffer.concat([session.input.video.srtp_key, session.input.video.srtp_salt]).toString('base64');
        const args = ['-hide_banner','-loglevel','error', ...(uri.startsWith('rtsp') ? ['-rtsp_transport','tcp'] : []), '-i',uri,
          '-an','-sn','-dn','-c:v','libx264','-preset','ultrafast','-tune','zerolatency','-pix_fmt','yuv420p',
          '-profile:v',['baseline','main','high'][v.profile]??'baseline','-level:v',['3.1','3.2','4.0'][v.level]??'3.1','-g',String(v.fps*2),'-bf','0',
          '-vf',`scale=${v.width}:${v.height}:force_original_aspect_ratio=decrease,pad=${v.width}:${v.height}:(ow-iw)/2:(oh-ih)/2`,
          '-r',String(v.fps),'-b:v',`${v.max_bit_rate}k`,'-maxrate',`${v.max_bit_rate}k`,'-bufsize',`${v.max_bit_rate * 2}k`,
          '-payload_type',String(v.pt),'-ssrc',String(session.ssrc),'-f','rtp','-srtp_out_suite','AES_CM_128_HMAC_SHA1_80','-srtp_out_params',key,
          `srtp://${peer}:${session.input.video.port}?rtcpport=${session.input.video.port}&localrtpport=${session.port}&pkt_size=${Math.min(v.mtu,1316)}`];
        const child = spawn(process.env.HOMETRUTH_FFMPEG_BINARY || 'ffmpeg', args, { stdio: 'ignore' }); session.process = child;
        let replied = false;
        child.once('spawn', () => { replied = true; callback(); });
        child.once('error', () => { if (!replied) callback(new Error('Camera encoder unavailable')); stop(input.sessionID); });
        child.once('exit', () => { stop(input.sessionID); controller.forceStopStreamingSession(input.sessionID); });
        session.timeout = setTimeout(() => { stop(input.sessionID); controller.forceStopStreamingSession(input.sessionID); }, 10 * 60 * 1000);
      }).catch(() => { stop(input.sessionID); callback(new Error('Camera stream unavailable')); });
    },
  };
  const Controller = item.profile === 'VideoDoorbell' ? DoorbellController : CameraController;
  const controller = new Controller({ cameraStreamCount: 2, delegate, streamingOptions: {
    supportedCryptoSuites: [0], video: { codec: { profiles: [0,1,2], levels: [0,1,2] }, resolutions: [[320,240,15],[640,360,30],[1280,720,30],[1920,1080,30]] },
  } });
  return { controller, close: () => { for (const id of sessions.keys()) stop(id); } };
}

export function resizeSnapshot(bytes, width, height) {
  if (![width,height].every(n=>Number.isInteger(n)&&n>0&&n<=4096) || bytes.length>10*1024*1024) return Promise.reject(new Error('Invalid snapshot dimensions'));
  return new Promise((resolve,reject)=>{
    const child=spawn(process.env.HOMETRUTH_FFMPEG_BINARY||'ffmpeg',['-hide_banner','-loglevel','error','-i','pipe:0','-frames:v','1','-vf',`scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,'-f','image2pipe','-vcodec','mjpeg','pipe:1'],{stdio:['pipe','pipe','ignore']});
    const chunks=[];let size=0;const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Snapshot encoding timed out'));},4000);
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>10*1024*1024){child.kill('SIGKILL');return;}chunks.push(chunk);});
    child.once('error',()=>{clearTimeout(timer);reject(new Error('Snapshot encoder unavailable'));});
    child.once('exit',code=>{clearTimeout(timer);if(code!==0||!size||size>10*1024*1024)reject(new Error('Snapshot encoding failed'));else resolve(Buffer.concat(chunks));});
    child.stdin.on('error',()=>{});child.stdin.end(bytes);
  });
}
