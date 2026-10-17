/* SPDX-License-Identifier: GPL-3.0-only
 * Disposable native known-answer checks; inputs are published test vectors.
 * This executable is not part of the APK and never accesses account data.
 */
#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <openssl/kdf.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(x) do { if (!(x)) { fprintf(stderr, "Native crypto check failed at line %d\n", __LINE__); exit(1); } } while (0)
static void unhex(const char *hex, unsigned char *out) {
    for (size_t i = 0; i < strlen(hex) / 2; i++) {
        unsigned int byte; CHECK(sscanf(hex + 2 * i, "%2x", &byte) == 1); out[i] = (unsigned char)byte;
    }
}
static void equal(const unsigned char *actual, const char *hex) {
    unsigned char expected[128]; CHECK(strlen(hex) / 2 <= sizeof(expected)); unhex(hex, expected);
    CHECK(CRYPTO_memcmp(actual, expected, strlen(hex) / 2) == 0);
}
static int gcm_open(const unsigned char *ciphertext, int count, const unsigned char *tag) {
    const unsigned char key[16] = {0}, iv[12] = {0}; unsigned char out[32]; int size = 0;
    EVP_CIPHER_CTX *ctx = EVP_CIPHER_CTX_new(); CHECK(ctx);
    CHECK(EVP_DecryptInit_ex(ctx, EVP_aes_128_gcm(), NULL, key, iv) == 1);
    CHECK(EVP_DecryptUpdate(ctx, out, &size, ciphertext, count) == 1);
    CHECK(EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_TAG, 16, (void *)tag) == 1);
    int result = EVP_DecryptFinal_ex(ctx, out + size, &size);
    EVP_CIPHER_CTX_free(ctx); return result;
}
static void aes_gcm(void) {
    const unsigned char key[16] = {0}, iv[12] = {0}, plain[16] = {0}; unsigned char out[32], tag[16]; int size = 0;
    for (int count = 0; count <= 16; count += 16) {
        EVP_CIPHER_CTX *ctx = EVP_CIPHER_CTX_new(); CHECK(ctx);
        CHECK(EVP_EncryptInit_ex(ctx, EVP_aes_128_gcm(), NULL, key, iv) == 1);
        CHECK(EVP_EncryptUpdate(ctx, out, &size, plain, count) == 1 && size == count);
        CHECK(EVP_EncryptFinal_ex(ctx, out + size, &size) == 1 && size == 0);
        CHECK(EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_GET_TAG, 16, tag) == 1);
        if (count) { equal(out, "0388dace60b6a392f328c2b971b2fe78"); equal(tag, "ab6e47d42cec13bdf53a67b21257bddf"); }
        else equal(tag, "58e2fccefa7e3061367f1d57a4e7455a");
        EVP_CIPHER_CTX_free(ctx);
        CHECK(gcm_open(out, count, tag) == 1); tag[0] ^= 1; CHECK(gcm_open(out, count, tag) != 1);
    }
}
static void sha_hmac_hkdf(void) {
    unsigned char out[64], key[22], salt[13], info[10]; unsigned int length = 0;
    CHECK(EVP_Digest("abc", 3, out, &length, EVP_sha256(), NULL) == 1 && length == 32);
    equal(out, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    memset(key, 0x0b, sizeof(key)); CHECK(HMAC(EVP_sha256(), key, 20, (const unsigned char *)"Hi There", 8, out, &length));
    equal(out, "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
    unhex("000102030405060708090a0b0c", salt); unhex("f0f1f2f3f4f5f6f7f8f9", info);
    EVP_PKEY_CTX *ctx = EVP_PKEY_CTX_new_id(EVP_PKEY_HKDF, NULL); CHECK(ctx);
    CHECK(EVP_PKEY_derive_init(ctx) == 1 && EVP_PKEY_CTX_set_hkdf_md(ctx, EVP_sha256()) == 1);
    CHECK(EVP_PKEY_CTX_set1_hkdf_key(ctx, key, sizeof(key)) == 1 && EVP_PKEY_CTX_set1_hkdf_salt(ctx, salt, sizeof(salt)) == 1);
    CHECK(EVP_PKEY_CTX_add1_hkdf_info(ctx, info, sizeof(info)) == 1); size_t size = 42;
    CHECK(EVP_PKEY_derive(ctx, out, &size) == 1 && size == 42);
    equal(out, "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865");
    EVP_PKEY_CTX_free(ctx);
}
static void x25519(void) {
    unsigned char secret[32], peer[32], shared[32];
    unhex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a", secret);
    unhex("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f", peer);
    EVP_PKEY *own = EVP_PKEY_new_raw_private_key(EVP_PKEY_X25519, NULL, secret, 32);
    EVP_PKEY *remote = EVP_PKEY_new_raw_public_key(EVP_PKEY_X25519, NULL, peer, 32); CHECK(own && remote);
    EVP_PKEY_CTX *ctx = EVP_PKEY_CTX_new(own, NULL); CHECK(ctx);
    CHECK(EVP_PKEY_derive_init(ctx) == 1 && EVP_PKEY_derive_set_peer(ctx, remote) == 1); size_t size = 32;
    CHECK(EVP_PKEY_derive(ctx, shared, &size) == 1 && size == 32);
    equal(shared, "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742");
    EVP_PKEY_CTX_free(ctx); EVP_PKEY_free(own); EVP_PKEY_free(remote);
}
static void ed25519(void) {
    unsigned char secret[32], pub[32], sig[64];
    unhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", secret);
    unhex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", pub);
    EVP_PKEY *own = EVP_PKEY_new_raw_private_key(EVP_PKEY_ED25519, NULL, secret, 32);
    EVP_PKEY *peer = EVP_PKEY_new_raw_public_key(EVP_PKEY_ED25519, NULL, pub, 32); CHECK(own && peer);
    EVP_MD_CTX *ctx = EVP_MD_CTX_new(); CHECK(ctx); size_t size = 64;
    CHECK(EVP_DigestSignInit(ctx, NULL, NULL, NULL, own) == 1 && EVP_DigestSign(ctx, sig, &size, (const unsigned char *)"", 0) == 1 && size == 64);
    equal(sig, "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b");
    EVP_MD_CTX_free(ctx); ctx = EVP_MD_CTX_new(); CHECK(ctx);
    CHECK(EVP_DigestVerifyInit(ctx, NULL, NULL, NULL, peer) == 1 && EVP_DigestVerify(ctx, sig, 64, (const unsigned char *)"", 0) == 1);
    sig[0] ^= 1; CHECK(EVP_DigestVerify(ctx, sig, 64, (const unsigned char *)"", 0) != 1);
    EVP_MD_CTX_free(ctx); EVP_PKEY_free(own); EVP_PKEY_free(peer);
}
int main(void) {
    CHECK(strncmp(OpenSSL_version(OPENSSL_VERSION), "OpenSSL 3.6.5 ", 14) == 0);
    sha_hmac_hkdf(); aes_gcm(); x25519(); ed25519();
    puts("OpenSSL 3.6.5 native KATs passed: SHA256, HMAC, HKDF, AES-GCM including empty/tampered tags, X25519, Ed25519.");
    return 0;
}
