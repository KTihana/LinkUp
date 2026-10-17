/* SPDX-License-Identifier: GPL-3.0-only
 * Disposable Android loader check. Does not create keys, interfaces or tunnels.
 */
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(int argc, char **argv) {
    if (argc != 2) return 1;
    void *library = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
    if (!library) { puts("WireGuard Android runtime load failed"); return 2; }
    char *(*version)(void) = (char *(*)(void))dlsym(library, "wgVersion");
    if (!version) return 3;
    char *value = version();
    int ok = value != NULL && strcmp(value, "2631ce9") == 0;
    free(value);
    if (!ok) return 4;
    puts("WireGuard Android Go runtime loaded; upstream version2631ce9 confirmed; no tunnel activated.");
    return 0;
}
