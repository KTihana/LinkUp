// SPDX-License-Identifier: GPL-3.0-only
// Two ephemeral peers, TCP-only: verifies real public discovery and relay delivery.
#include "bootstrap.h"
#include <tox/tox.h>
#include <tox/tox_options.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <time.h>
static int received = 0;
static void packet(Tox *t, uint32_t f, const uint8_t *data, size_t len, void *u) { if (len == 1300 && data[0] == 160 && data[1299] == 77) received++; }
static void key(const char *hex, unsigned char *out) { for(int i=0;i<32;i++) { unsigned int n; sscanf(hex+i*2,"%2x",&n); out[i]=n; } }
int main() {
 struct Tox_Options *o=tox_options_new(NULL); tox_options_set_udp_enabled(o,false); tox_options_set_local_discovery_enabled(o,false);
 Tox *a=tox_new(o,NULL),*b=tox_new(o,NULL); tox_options_free(o); if(!a||!b)return 2;
 uint8_t ap[32],bp[32],node[32]; tox_self_get_public_key(a,ap); tox_self_get_public_key(b,bp);
 uint32_t af=tox_friend_add_norequest(a,bp,NULL); tox_friend_add_norequest(b,ap,NULL); tox_callback_friend_lossless_packet(b,packet);
 for (size_t i = 0; i < sizeof(nodes) / sizeof(nodes[0]); i++) {
  key(nodes[i].key, node);
  tox_bootstrap(a, nodes[i].host, nodes[i].port, node, NULL);
  tox_bootstrap(b, nodes[i].host, nodes[i].port, node, NULL);
  for (size_t j = 0; j < 4 && nodes[i].tcp[j]; j++) {
   tox_add_tcp_relay(a, nodes[i].host, nodes[i].tcp[j], node, NULL);
   tox_add_tcp_relay(b, nodes[i].host, nodes[i].tcp[j], node, NULL);
  }
 }
 time_t end=time(NULL)+120; int sent=0; uint8_t payload[1300]; memset(payload,77,sizeof(payload));payload[0]=160;
 while(time(NULL)<end && !received) {
  tox_iterate(a,NULL);tox_iterate(b,NULL);
  if(!sent && tox_friend_get_connection_status(a,af,NULL)!=TOX_CONNECTION_NONE) { sent=tox_friend_send_lossless_packet(a,af,payload,1300,NULL); if(sent){ puts("Sent over public Tox TCP relay");fflush(stdout);} }
  usleep(20000);
 }
 printf("network A=%d B=%d sent=%d received=%d\n",tox_self_get_connection_status(a),tox_self_get_connection_status(b),sent,received);
 tox_kill(a);tox_kill(b);return received?0:1;
}
