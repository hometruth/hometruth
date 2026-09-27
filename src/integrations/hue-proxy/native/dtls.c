/* A record-preserving DTLS-PSK endpoint. No Hue or routing logic lives here.
 * argv: server|client IPv4 port. stdin: identity\nkeyhex\n, then uint32 BE
 * length + application bytes. stdout: JSON ready/connected/frame messages.
 * Secrets travel over an inherited pipe, never argv, environment or logs.
 */
#include <openssl/ssl.h>
#include <openssl/rand.h>
#include <openssl/hmac.h>
#include <openssl/err.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <poll.h>
#include <signal.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>

static char identity[257];
static unsigned char key[16], cookie_key[32];
static int fail(const char *stage) { fprintf(stderr, "DTLS %s failed\n", stage); return 1; }
static unsigned int server_psk(SSL *ssl, const char *name, unsigned char *psk, unsigned int max) {
  (void)ssl; (void)name;
  // Accept whatever identity the client presents and answer with our single key: this is a one-session relay, and the PSK
  // itself is the authenticator — a wrong key fails the Finished step anyway. A Hue client's Entertainment identity does not
  // always equal the username it authenticates CLIP with, and rejecting on that string is what broke real clients (diyHue's
  // s_server only warns on a mismatch and returns the key regardless).
  if (max < sizeof(key)) return 0;
  memcpy(psk, key, sizeof(key)); return sizeof(key);
}
static unsigned int client_psk(SSL *ssl, const char *hint, char *name, unsigned int max_name, unsigned char *psk, unsigned int max) {
  (void)ssl; (void)hint;
  if (strlen(identity) + 1 > max_name || sizeof(key) > max) return 0;
  strcpy(name, identity); memcpy(psk, key, sizeof(key)); return sizeof(key);
}
static int make_cookie(SSL *ssl, unsigned char *cookie, unsigned int *length) {
  struct sockaddr_in peer;
  memset(&peer, 0, sizeof(peer));
  BIO_dgram_get_peer(SSL_get_rbio(ssl), &peer);
  unsigned char data[6];
  memcpy(data, &peer.sin_addr, 4); memcpy(data + 4, &peer.sin_port, 2);
  return HMAC(EVP_sha256(), cookie_key, sizeof(cookie_key), data, sizeof(data), cookie, length) != NULL;
}
static int check_cookie(SSL *ssl, const unsigned char *cookie, unsigned int length) {
  unsigned char expected[EVP_MAX_MD_SIZE]; unsigned int expected_length = 0;
  return make_cookie(ssl, expected, &expected_length) && length == expected_length && CRYPTO_memcmp(cookie, expected, length) == 0;
}
static int line(char *out, size_t capacity) {
  size_t i = 0;
  while (i + 1 < capacity) { char c; if (read(STDIN_FILENO, &c, 1) != 1) return 0; if (c == '\n') { out[i] = 0; return 1; } out[i++] = c; }
  return 0;
}
static int exact(unsigned char *out, size_t size) {
  size_t offset = 0;
  while (offset < size) { ssize_t n = read(STDIN_FILENO, out + offset, size - offset); if (n < 0 && errno == EINTR) continue; if (n <= 0) return 0; offset += (size_t)n; }
  return 1;
}
int main(int argc, char **argv) {
  if (argc != 4) return fail("arguments");
  int server = strcmp(argv[1], "server") == 0;
  if (!server && strcmp(argv[1], "client")) return fail("mode");
  char hex[34];
  if (!line(identity, sizeof(identity)) || !identity[0] || !line(hex, sizeof(hex)) || strlen(hex) != 32) return fail("credentials");
  for (int i = 0; i < 16; i++) { unsigned int value; if (sscanf(hex + i * 2, "%2x", &value) != 1) return fail("key"); key[i] = (unsigned char)value; }
  OPENSSL_cleanse(hex, sizeof(hex));
  signal(SIGPIPE, SIG_DFL);
  alarm(20); /* bound pairing/handshake and orphaned startup */
  struct sockaddr_in addr;
  memset(&addr, 0, sizeof(addr)); addr.sin_family = AF_INET;
  char *end = NULL; long port = strtol(argv[3], &end, 10);
  if (!end || *end || port < 1 || port > 65535 || inet_pton(AF_INET, argv[2], &addr.sin_addr) != 1) return fail("address");
  addr.sin_port = htons((unsigned short)port);
  int fd = socket(AF_INET, SOCK_DGRAM, 0);
  if (fd < 0) return fail("socket");
  struct timeval timeout = { 1, 0 };
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
  if (server ? bind(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0 : connect(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) return fail("bind/connect");
  SSL_CTX *ctx = SSL_CTX_new(server ? DTLS_server_method() : DTLS_client_method());
  // A Hue client (a TV's Hue Sync) may offer only the CCM PSK suites, never GCM, so a GCM-only server shares no cipher with it
  // and the handshake dies before a frame. Offer the same breadth diyHue does; @SECLEVEL=0 is what lets OpenSSL 3 enable these PSK
  // suites at all. The client leg keeps GCM only: the real bridge speaks it, and narrowing our own outbound offer costs nothing.
  const char *ciphers = server ? "PSK-AES128-GCM-SHA256:PSK-AES128-CCM8:PSK-AES128-CCM:@SECLEVEL=0" : "PSK-AES128-GCM-SHA256";
  if (!ctx || !SSL_CTX_set_min_proto_version(ctx, DTLS1_2_VERSION) || !SSL_CTX_set_max_proto_version(ctx, DTLS1_2_VERSION) || !SSL_CTX_set_cipher_list(ctx, ciphers)) return fail("context");
  SSL_CTX_set_verify(ctx, SSL_VERIFY_NONE, NULL);
  if (server) {
    if (RAND_bytes(cookie_key, sizeof(cookie_key)) != 1) return fail("random");
    SSL_CTX_set_psk_server_callback(ctx, server_psk);
    SSL_CTX_set_cookie_generate_cb(ctx, make_cookie);
    SSL_CTX_set_cookie_verify_cb(ctx, check_cookie);
  } else SSL_CTX_set_psk_client_callback(ctx, client_psk);
  SSL *ssl = SSL_new(ctx);
  BIO *bio = BIO_new_dgram(fd, BIO_NOCLOSE);
  if (!ssl || !bio) return fail("allocation");
  // Send the client a PSK identity hint (the username), as a real Hue bridge and diyHue's `s_server -psk_identity` do.
  // A Hue client can wait for this hint before it starts an Entertainment stream, so its absence looks like a silent client.
  if (server && !SSL_use_psk_identity_hint(ssl, identity)) return fail("psk hint");
  SSL_set_bio(ssl, bio, bio);
  SSL_set_options(ssl, SSL_OP_NO_QUERY_MTU);
  SSL_set_mtu(ssl, 1200);
  BIO_ctrl(bio, BIO_CTRL_DGRAM_SET_RECV_TIMEOUT, 0, &timeout);
  puts("{\"type\":\"ready\"}"); fflush(stdout);
  if (server) {
    BIO_ADDR *peer = BIO_ADDR_new();
    if (!peer) return fail("peer");
    int result;
    do { result = DTLSv1_listen(ssl, peer); } while (result == 0);
    if (result < 0) return fail("listen");
    struct sockaddr_in remote;
    memset(&remote, 0, sizeof(remote)); remote.sin_family = AF_INET;
    size_t size = sizeof(remote.sin_addr);
    if (!BIO_ADDR_rawaddress(peer, &remote.sin_addr, &size)) return fail("peer address");
    remote.sin_port = BIO_ADDR_rawport(peer);
    if (connect(fd, (struct sockaddr *)&remote, sizeof(remote)) < 0) return fail("peer connect");
    BIO_ctrl(bio, BIO_CTRL_DGRAM_SET_CONNECTED, 0, &remote);
    BIO_ADDR_free(peer);
  } else BIO_ctrl(bio, BIO_CTRL_DGRAM_SET_CONNECTED, 0, &addr);
  for (;;) {
    int result = server ? SSL_accept(ssl) : SSL_connect(ssl);
    if (result == 1) break;
    int error = SSL_get_error(ssl, result);
    if (error != SSL_ERROR_WANT_READ && error != SSL_ERROR_WANT_WRITE) {
      // OpenSSL knows the specific reason (unknown psk identity, no shared cipher, bad record MAC …); surface it, not a bare "handshake".
      unsigned long reason = ERR_peek_last_error();
      if (reason) fprintf(stderr, "DTLS handshake failed: %s\n", ERR_reason_error_string(reason));
      else fprintf(stderr, "DTLS handshake failed (peer closed)\n");
      return 1;
    }
    DTLSv1_handle_timeout(ssl);
  }
  alarm(0);
  // Carry the negotiated cipher up so a stream that connects but never sends frames can be told apart by what was agreed. Cipher names are [A-Z0-9-], JSON-safe.
  printf("{\"type\":\"connected\",\"cipher\":\"%s\"}\n", SSL_get_cipher_name(ssl)); fflush(stdout);
  struct pollfd polls[2] = { {fd, POLLIN, 0}, {STDIN_FILENO, POLLIN, 0} };
  unsigned char buffer[65536];
  for (;;) {
    int polled = poll(polls, 2, SSL_pending(ssl) ? 0 : 1000);
    if (polled < 0) { if (errno == EINTR) continue; return fail("poll"); }
    if (polls[1].revents & (POLLHUP | POLLERR | POLLNVAL)) break;
    if (polls[1].revents & POLLIN) {
      unsigned char length[4];
      if (!exact(length, 4)) break;
      unsigned int size = ((unsigned int)length[0] << 24) | ((unsigned int)length[1] << 16) | ((unsigned int)length[2] << 8) | length[3];
      if (!size || size > 16384 || !exact(buffer, size)) return fail("record length");
      if (SSL_write(ssl, buffer, (int)size) != (int)size) return fail("write");
    }
    if ((polls[0].revents & POLLIN) || SSL_pending(ssl)) {
      int size = SSL_read(ssl, buffer, sizeof(buffer));
      if (size > 0) {
        fputs("{\"type\":\"frame\",\"hex\":\"", stdout);
        for (int i = 0; i < size; i++) printf("%02x", buffer[i]);
        puts("\"}"); fflush(stdout);
      } else {
        int error = SSL_get_error(ssl, size);
        if (error == SSL_ERROR_ZERO_RETURN) break;
        if (error != SSL_ERROR_WANT_READ && error != SSL_ERROR_WANT_WRITE) return fail("read");
      }
    }
  }
  SSL_shutdown(ssl); SSL_free(ssl); SSL_CTX_free(ctx); close(fd);
  OPENSSL_cleanse(key, sizeof(key));
  return 0;
}
