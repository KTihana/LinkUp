// SPDX-License-Identifier: GPL-3.0-only
#include <jni.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <tox/tox.h>
#include <tox/tox_options.h>
typedef struct { Tox *tox; JNIEnv *env; jobject listener; jmethodID packet, connection, network; } Client;
static void connection(Tox *tox, uint32_t friend, Tox_Connection status, void *data) {
  Client *c = data; (*c->env)->CallVoidMethod(c->env, c->listener, c->connection, (jint)friend, (jint)status);
}
static void network(Tox *tox, Tox_Connection status, void *data) {
  Client *c = data; (*c->env)->CallVoidMethod(c->env, c->listener, c->network, (jint)status);
}
static void packet(Tox *tox, uint32_t friend, const uint8_t *bytes, size_t size, void *data) {
  Client *c = data;
  if (size < 9 || size > 1373 || bytes[0] != 160) return;
  jbyteArray array = (*c->env)->NewByteArray(c->env, size);
  if (!array) return;
  (*c->env)->SetByteArrayRegion(c->env, array, 0, size, (const jbyte *)bytes);
  (*c->env)->CallVoidMethod(c->env, c->listener, c->packet, (jint)friend, array);
  (*c->env)->DeleteLocalRef(c->env, array);
}
#define JNI(name) Java_expo_modules_commonnearby_LinkUpToxModule_##name
JNIEXPORT jlong JNICALL JNI(create)(JNIEnv *env, jobject self, jbyteArray secret) {
  if ((*env)->GetArrayLength(env, secret) != 32) return 0;
  uint8_t key[32]; (*env)->GetByteArrayRegion(env, secret, 0, 32, (jbyte *)key);
  struct Tox_Options *options = tox_options_new(NULL);
  if (!options) return 0;
  tox_options_set_savedata_type(options, TOX_SAVEDATA_TYPE_SECRET_KEY);
  tox_options_set_savedata_data(options, key, 32);
  tox_options_set_ipv6_enabled(options, true);
  tox_options_set_local_discovery_enabled(options, false);
  Tox *tox = tox_new(options, NULL);
  tox_options_free(options);
  volatile uint8_t *wipe = key; for (int i=0;i<32;i++) wipe[i]=0;
  if (!tox) return 0;
  Client *c = calloc(1, sizeof(Client));
  if (!c) { tox_kill(tox); return 0; }
  c->tox = tox; c->listener = (*env)->NewGlobalRef(env, self);
  jclass cls = (*env)->GetObjectClass(env, self);
  c->packet = (*env)->GetMethodID(env, cls, "onPacket", "(I[B)V");
  c->connection = (*env)->GetMethodID(env, cls, "onConnection", "(II)V");
  c->network = (*env)->GetMethodID(env, cls, "onNetwork", "(I)V");
  (*env)->DeleteLocalRef(env, cls);
  tox_callback_friend_lossless_packet(tox, packet);
  tox_callback_friend_connection_status(tox, connection);
  tox_callback_self_connection_status(tox, network);
  return (jlong)(intptr_t)c;
}
JNIEXPORT void JNICALL JNI(destroy)(JNIEnv *env, jobject self, jlong handle) {
  Client *c = (Client *)(intptr_t)handle; if (!c) return;
  tox_kill(c->tox); (*env)->DeleteGlobalRef(env, c->listener); free(c);
}
JNIEXPORT jint JNICALL JNI(addFriend)(JNIEnv *env, jobject self, jlong handle, jbyteArray publicKey) {
  if ((*env)->GetArrayLength(env, publicKey) != 32) return -1;
  uint8_t key[32]; (*env)->GetByteArrayRegion(env, publicKey, 0, 32, (jbyte *)key);
  return tox_friend_add_norequest(((Client *)(intptr_t)handle)->tox, key, NULL);
}
JNIEXPORT void JNICALL JNI(bootstrap)(JNIEnv *env, jobject self, jlong handle, jstring host, jint port, jbyteArray key, jboolean tcp) {
  if ((*env)->GetArrayLength(env, key) != 32 || port < 1 || port > 65535) return;
  const char *name = (*env)->GetStringUTFChars(env, host, NULL); if (!name) return;
  uint8_t bytes[32]; (*env)->GetByteArrayRegion(env, key, 0, 32, (jbyte *)bytes);
  Tox *tox = ((Client *)(intptr_t)handle)->tox;
  if (tcp) tox_add_tcp_relay(tox, name, port, bytes, NULL); else tox_bootstrap(tox, name, port, bytes, NULL);
  (*env)->ReleaseStringUTFChars(env, host, name);
}
JNIEXPORT jint JNICALL JNI(iterate)(JNIEnv *env, jobject self, jlong handle) {
  Client *c = (Client *)(intptr_t)handle; c->env = env;
  tox_iterate(c->tox, c); c->env = NULL;
  return tox_iteration_interval(c->tox);
}
JNIEXPORT jboolean JNICALL JNI(sendPacket)(JNIEnv *env, jobject self, jlong handle, jint friend, jbyteArray packet) {
  jsize size = (*env)->GetArrayLength(env, packet); if (size < 9 || size > 1373) return false;
  uint8_t bytes[1373]; (*env)->GetByteArrayRegion(env, packet, 0, size, (jbyte *)bytes);
  return tox_friend_send_lossless_packet(((Client *)(intptr_t)handle)->tox, friend, bytes, size, NULL);
}
