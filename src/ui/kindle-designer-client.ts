export const KINDLE_DESIGNER_CLIENT = String.raw`
(() => {
  const root = document.querySelector('[data-designer]');
  const settings = JSON.parse(root.dataset.settings), elements = JSON.parse(root.dataset.elements);
  let config = settings.config, revision = settings.revision, selected = null, scale = 1, dragging = null;
  let saved = root.dataset.saved === '1' ? JSON.stringify(config) : null;
  let counter = 0, previewTimer, previewSequence = 0, previewBusy = false, previewPending = false;
  const undo = [], redo = [];
  const $ = (id) => document.getElementById(id);
  const canvas = () => config.canvas;
  const selectedWidget = () => canvas().widgets.find(w => w.id === selected);
  const clone = value => JSON.parse(JSON.stringify(value));
  const elementKey = w => w.source === 'group' ? 'group/' + w.deviceId : w.deviceId;
  const elementFor = w => elements.find(element => element.key === elementKey(w));
  const name = w => w.kind === 'device' ? w.label || elementFor(w)?.name || w.deviceId : ht.t('designer.' + w.kind);
  const say = (message, tone) => ht.say($('design-feedback'), message, tone);
  const snap = value => Math.round(value / canvas().grid) * canvas().grid;
  const clamp = w => {
    w.width = Math.round(Math.max(w.kind === 'device' ? 128 : 8, Math.min(canvas().width, w.width)));
    w.height = Math.round(Math.max(w.kind === 'device' ? 96 : 4, Math.min(canvas().height, w.height)));
    w.x = Math.round(Math.max(0, Math.min(canvas().width - w.width, w.x)));
    w.y = Math.round(Math.max(0, Math.min(canvas().height - w.height, w.y)));
  };
  const remember = before => { undo.push(before); if (undo.length > 50) undo.shift(); redo.length = 0; };
  function changed(updatePreview = true) {
    counter++;
    $('design-dirty').textContent = JSON.stringify(config) === saved ? ht.t('designer.saved') : ht.t('designer.unsaved');
    $('design-undo').disabled = undo.length === 0; $('design-redo').disabled = redo.length === 0;
    if (updatePreview) schedulePreview();
  }
  function commit(change, inspector = true) {
    const before = clone(config); change();
    if (JSON.stringify(before) === JSON.stringify(config)) return;
    remember(before); render(inspector); changed();
  }
  function dimensions() {
    const width = Math.max(180, $('design-viewport').clientWidth - 32);
    const height = Math.max(180, Math.floor(window.innerHeight * .8) - 34);
    const zoom = $('design-zoom').value;
    scale = zoom === 'fit' ? Math.min(1, width / canvas().width, height / canvas().height) : Number(zoom);
    Object.assign($('design-paper').style, { width: canvas().width + 'px', height: canvas().height + 'px', transform: 'scale(' + scale + ')' });
    Object.assign($('design-stage').style, { width: Math.ceil(canvas().width * scale) + 'px', height: Math.ceil(canvas().height * scale) + 'px' });
    const origin = $('design-stage').getBoundingClientRect();
    // At 100%, land the rendered pixels on whole screen pixels too.
    $('design-paper').style.left = Math.round(origin.left) - origin.left + 'px';
    $('design-paper').style.top = Math.round(origin.top) - origin.top + 'px';
    $('design-size').textContent = canvas().width + ' × ' + canvas().height;
  }
  function place(w) {
    const css = { left: w.x + 'px', top: w.y + 'px', width: w.width + 'px', height: w.height + 'px' };
    const overlay = document.querySelector('[data-overlay="' + w.id + '"]');
    if (overlay) Object.assign(overlay.style, css);
    const widget = $('canvas-widget-' + w.id);
    if (widget) Object.assign(widget.style, css);
  }
  function overlays() {
    const layer = $('design-overlays'); layer.replaceChildren();
    canvas().widgets.forEach(w => {
      const box = document.createElement('div'); box.dataset.overlay = w.id; box.className = 'widget-overlay';
      const hit = document.createElement('button'); hit.type = 'button'; hit.dataset.op = 'move'; hit.dataset.id = w.id; hit.className = 'widget-move';
      hit.setAttribute('aria-label', ht.t('designer.selectWidget', { name: name(w) }));
      const tag = document.createElement('span'); tag.className = 'widget-tag'; tag.textContent = name(w); hit.append(tag);
      const resize = document.createElement('button'); resize.type = 'button'; resize.dataset.op = 'resize'; resize.dataset.id = w.id; resize.className = 'widget-resize'; resize.textContent = '↘'; resize.setAttribute('aria-label', ht.t('designer.resizeWidget', { name: name(w) }));
      box.append(hit, resize); layer.append(box); place(w);
    });
    selection();
  }
  function selection() {
    document.querySelectorAll('[data-overlay]').forEach(node => node.dataset.selected = String(node.dataset.overlay === selected));
    $('design-remove').disabled = !selectedWidget(); $('design-duplicate').disabled = !selectedWidget();
    $('design-front').disabled = !selectedWidget(); $('design-back').disabled = !selectedWidget();
    ht.pageState.update({ widget: selected });
  }
  function option(value, label) { return new Option(label, value); }
  function inputField(label, key, value, opts = {}) {
    const wrap = document.createElement('label'); wrap.className = 'field';
    const span = document.createElement('span'); span.textContent = label;
    const node = document.createElement(opts.options ? 'select' : opts.multiline ? 'textarea' : 'input');
    node.dataset.property = key;
    if (opts.options) opts.options.forEach(([v, text]) => node.add(option(v, text)));
    else if (!opts.multiline) node.type = opts.type || 'text';
    if (opts.type === 'number') node.required = true;
    for (const property of ['min', 'max', 'step', 'maxLength']) if (opts[property] !== undefined) node[property] = opts[property];
    if (opts.type === 'checkbox') node.checked = value; else node.value = value;
    node.addEventListener('change', () => {
      if (!node.checkValidity()) { node.reportValidity(); return; }
      const w = selectedWidget(); if (!w) return;
      commit(() => {
        w[key] = opts.type === 'checkbox' ? node.checked : opts.type === 'number' ? Number(node.value) : node.value;
        if (key === 'deviceId') {
          w.source = node.value.startsWith('group/') ? 'group' : 'device';
          w.deviceId = w.source === 'group' ? node.value.slice(6) : node.value;
          w.capability = 'auto';
        }
        clamp(w);
      });
    });
    wrap.append(span, node); return wrap;
  }
  function inspector() {
    const area = $('design-properties'); area.replaceChildren();
    const w = selectedWidget(); $('design-inspector-empty').hidden = Boolean(w);
    $('design-selection').textContent = w ? name(w) : '';
    if (!w) return;
    const geometry = document.createElement('div'); geometry.className = 'property-grid';
    [['x','designer.x',0,canvas().width],['y','designer.y',0,canvas().height],['width','designer.width',w.kind==='device'?128:8,canvas().width],['height','designer.height',w.kind==='device'?96:4,canvas().height]].forEach(([key,label,min,max]) => geometry.append(inputField(ht.t(label),key,w[key],{type:'number',min,max,step:1})));
    area.append(geometry);
    if (w.kind === 'device') {
      const element = elementFor(w);
      const choices = elements.map(element => [element.key,element.name + ' · ' + element.modelTitle]); if(!element)choices.unshift([elementKey(w),w.deviceId]);
      const capabilities = [['auto',ht.t('designer.wholeElement')],...(element?.capabilities || []).map(kind => [kind,ht.t('cap.'+kind)])];
      if(!capabilities.some(([kind])=>kind===w.capability))capabilities.push([w.capability,ht.t('cap.'+w.capability)]);
      area.append(inputField(ht.t('designer.element'),'deviceId',elementKey(w),{options:choices}),inputField(ht.t('kindle.capability'),'capability',w.capability,{options:capabilities}),inputField(ht.t('kindle.customLabel'),'label',w.label,{maxLength:80}),inputField(ht.t('designer.showLabel'),'showLabel',w.showLabel,{type:'checkbox'}),inputField(ht.t('kindle.display'),'mode',w.mode,{options:[['auto',ht.t('kindle.interactive')],['status',ht.t('kindle.statusOnly')]]}));
      if (element) {
        const link = document.createElement('a'); link.href = element.page; link.textContent = ht.t('designer.openElement'); area.append(link);
      }
    }
    if (w.kind === 'text') area.append(inputField(ht.t('designer.text'),'text',w.text,{multiline:true,maxLength:2000}));
    if (w.kind === 'clock') area.append(inputField(ht.t('designer.clockFormat'),'format',w.format,{options:[['time',ht.t('designer.time')],['dateTime',ht.t('designer.dateTime')]]}));
    if(w.kind!=='rule')area.append(inputField(ht.t('kindle.fontSize'),'fontSize',w.fontSize,{type:'number',min:14,max:120,step:1}),inputField(ht.t('designer.align'),'align',w.align,{options:[['left',ht.t('designer.left')],['center',ht.t('designer.center')],['right',ht.t('designer.right')]]}),inputField(ht.t('designer.border'),'border',w.border,{type:'checkbox'}));
  }
  function render(showInspector = true) {
    $('design-title').value = config.title; $('design-interval').value = config.refreshSeconds;
    $('canvas-width').value = canvas().width; $('canvas-height').value = canvas().height; $('canvas-grid').value = canvas().grid;
    dimensions(); overlays(); if(showInspector)inspector();
    $('design-empty').hidden = canvas().widgets.length > 0;
  }
  function schedulePreview() { clearTimeout(previewTimer); previewTimer = setTimeout(preview, 200); }
  async function preview() {
    if (previewBusy) { previewPending = true; return; }
    previewBusy = true;
    const sequence = ++previewSequence, version = counter, draft = clone(config);
    $('design-preview-status').textContent = ht.t('designer.updating');
    try {
      const result = await ht.request('/api/kindle/preview',{method:'POST',body:JSON.stringify(draft)});
      await new Promise((resolve, reject) => {
        const image = new Image(), timeout = setTimeout(() => reject(new Error(ht.t('designer.previewFailed'))), 10000);
        image.onload = () => { clearTimeout(timeout); resolve(); };
        image.onerror = () => { clearTimeout(timeout); reject(new Error(ht.t('designer.previewFailed'))); };
        image.src = result.frame.imageUrl;
      });
      if(sequence!==previewSequence || version!==counter || dragging)return;
      $('canvas-layout-css').textContent=result.css;
      $('design-render').innerHTML=result.html;
      $('design-preview-status').textContent=ht.t('designer.livePreview');
      dimensions();
      $('design-overflow').hidden=result.frame.overflow.length === 0;
    } catch(error) { if(sequence===previewSequence && version===counter){$('design-preview-status').textContent=ht.t('designer.previewFailed');say(error.message,'bad');} }
    finally { previewBusy=false; if(previewPending){previewPending=false;schedulePreview();} }
  }
  const freshId=()=> 'w-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,8);
  function add(kind, key) {
    if(canvas().widgets.length>=80){say(ht.t('designer.limit'),'bad');return;}
    const w={id:freshId(),kind,x:16,y:16,width:kind==='rule'?320:kind==='clock'?280:320,height:kind==='rule'?4:kind==='text'?100:kind==='clock'?120:220,fontSize:kind==='text'?36:24,align:'left',border:false};
    if(kind==='device') {
      const element = elements.find(element => element.key === key); if(!element)return;
      Object.assign(w,{deviceId:element.id,...(element.source === 'group' ? {source:'group'} : {}),capability:'auto',mode:'auto',label:'',showLabel:true});
    }
    if(kind==='text')w.text=ht.t('designer.newText');
    if(kind==='clock')w.format='dateTime';
    clamp(w);
    outer:for(let y=16;y+w.height<=canvas().height;y+=Math.max(8,canvas().grid))for(let x=16;x+w.width<=canvas().width;x+=Math.max(8,canvas().grid)){
      if(!canvas().widgets.some(o=>x<o.x+o.width+8 && x+w.width+8>o.x && y<o.y+o.height+8 && y+w.height+8>o.y)){w.x=x;w.y=y;break outer;}
    }
    commit(()=>{canvas().widgets.push(w);selected=w.id;});
  }
  ht.pageState.bind($('widget-search'), 'widget-search', () => {
    const normalize = text => text.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase(ht.locale);
    const terms=normalize($('widget-search').value).trim().split(/\s+/).filter(Boolean);
    const buttons=[...root.querySelectorAll('.widget-palette [data-search]')];
    buttons.forEach(button=>button.hidden=!terms.every(term=>normalize(button.dataset.search).includes(term)));
    $('widget-search-empty').hidden=buttons.some(button=>!button.hidden);
  });
  document.querySelectorAll('[data-add-kind]').forEach(button=>button.addEventListener('click',()=>add(button.dataset.addKind)));
  document.querySelectorAll('[data-add-element]').forEach(button=>button.addEventListener('click',()=>add('device',button.dataset.addElement)));
  $('design-overlays').addEventListener('pointerdown',event=>{
    const hit=event.target.closest('[data-op]');if(!hit || event.button!==0)return;
    event.preventDefault();selected=hit.dataset.id;selection();inspector();
    dragging={id:selected,op:hit.dataset.op,startX:event.clientX,startY:event.clientY,widget:clone(selectedWidget()),before:clone(config)};
    hit.setPointerCapture(event.pointerId);
  });
  $('design-overlays').addEventListener('pointermove',event=>{
    if(!dragging)return;const w=selectedWidget(),start=dragging.widget;
    const dx=(event.clientX-dragging.startX)/scale,dy=(event.clientY-dragging.startY)/scale;
    if(dragging.op==='resize'){w.width=snap(start.width+dx);w.height=snap(start.height+dy);}else{w.x=snap(start.x+dx);w.y=snap(start.y+dy);}
    clamp(w);place(w);
  });
  function finishDrag(cancel=false){
    if(!dragging)return;const before=dragging.before;dragging=null;
    if(cancel)config=before;
    else if(JSON.stringify(before)!==JSON.stringify(config)){remember(before);changed();}
    render();schedulePreview();
  }
  $('design-overlays').addEventListener('pointerup',()=>finishDrag());
  $('design-overlays').addEventListener('pointercancel',()=>finishDrag(true));
  $('design-overlays').addEventListener('click',event=>{const hit=event.target.closest('[data-op]');if(hit){selected=hit.dataset.id;selection();inspector();}});
  $('design-overlays').addEventListener('keydown',event=>{
    const hit=event.target.closest('[data-op]');if(!hit)return;selected=hit.dataset.id;
    if(event.key==='Enter'||event.key===' '){event.preventDefault();selection();inspector();return;}
    const vectors={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};const vector=vectors[event.key];
    if(vector){event.preventDefault();commit(()=>{const w=selectedWidget(),step=canvas().grid*(event.shiftKey?10:1);w.x+=vector[0]*step;w.y+=vector[1]*step;clamp(w);});document.querySelector('[data-op="move"][data-id="'+selected+'"]')?.focus();}
  });
  $('design-remove').onclick=()=>commit(()=>{canvas().widgets=canvas().widgets.filter(w=>w.id!==selected);selected=null;});
  $('design-duplicate').onclick=()=>{if(!selectedWidget()||canvas().widgets.length>=80)return;commit(()=>{const w=clone(selectedWidget());w.id=freshId();w.x+=canvas().grid*2;w.y+=canvas().grid*2;clamp(w);canvas().widgets.push(w);selected=w.id;});};
  for(const direction of ['front','back'])$('design-'+direction).onclick=()=>commit(()=>{const index=canvas().widgets.findIndex(w=>w.id===selected);if(index<0)return;const [w]=canvas().widgets.splice(index,1);if(direction==='front')canvas().widgets.push(w);else canvas().widgets.unshift(w);});
  $('design-clear').onclick=()=>commit(()=>{canvas().widgets=[];selected=null;});
  function history(from,to){if(!from.length)return;to.push(clone(config));config=from.pop();selected=null;render();changed();}
  $('design-undo').onclick=()=>history(undo,redo);$('design-redo').onclick=()=>history(redo,undo);
  document.addEventListener('keydown',event=>{
    if(/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName))return;
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();event.shiftKey?history(redo,undo):history(undo,redo);}
    if((event.key==='Delete'||event.key==='Backspace')&&selectedWidget()){event.preventDefault();$('design-remove').click();}
  });
  for(const property of ['width','height','grid'])$('canvas-'+property).addEventListener('change',event=>{
    if(!event.target.checkValidity()){event.target.reportValidity();return;}
    commit(()=>{canvas()[property]=Number(event.target.value);canvas().widgets.forEach(clamp);});
  });
  $('design-preset').onchange=event=>{if(event.target.value==='custom')return;const [width,height]=event.target.value.split('x').map(Number);commit(()=>{canvas().width=width;canvas().height=height;canvas().widgets.forEach(clamp);});};
  ht.pageState.bind($('design-zoom'), 'zoom', dimensions);new ResizeObserver(dimensions).observe($('design-viewport'));
  $('design-title').onchange=event=>{if(event.target.checkValidity()&&event.target.value.trim())commit(()=>config.title=event.target.value.trim());};
  $('design-interval').onchange=event=>{if(event.target.checkValidity())commit(()=>config.refreshSeconds=Number(event.target.value));};
  $('design-save').onclick=async()=>{
    document.activeElement?.blur();
    const invalid = [...root.querySelectorAll('input,select,textarea')].find(input => !input.checkValidity());
    if (invalid) { invalid.reportValidity(); return; }
    const draft=clone(config);$('design-save').disabled=true;say(ht.t('feedback.saving'));
    try{const result=await ht.request('/api/kindle/config',{method:'PUT',body:JSON.stringify({config:draft,revision})});revision=result.revision;saved=JSON.stringify(draft);changed();say(ht.t('designer.savedDetail'),'ok');}
    catch(error){say(error.message,'bad');}finally{$('design-save').disabled=false;}
  };
  ht.pageState.watch(['widget'], query => {
    const id = query.get('widget');
    selected = canvas().widgets.some(widget => widget.id === id) ? id : null;
    selection(); inspector();
  });
  render();changed(false);
})();
`;
