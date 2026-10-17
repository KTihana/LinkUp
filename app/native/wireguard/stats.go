// SPDX-License-Identifier: Apache-2.0
// LinkUp modification: only expose the public counters GoBackend consumes.
package main

import "strings"

func publicStats(settings string) string {
	var public strings.Builder
	for _, line := range strings.Split(settings, "\n") {
		if strings.HasPrefix(line, "public_key=") || strings.HasPrefix(line, "rx_bytes=") || strings.HasPrefix(line, "tx_bytes=") || strings.HasPrefix(line, "last_handshake_time_sec=") || strings.HasPrefix(line, "last_handshake_time_nsec=") {
			public.WriteString(line)
			public.WriteByte('\n')
		}
	}
	return public.String()
}
