// SPDX-License-Identifier: Apache-2.0
package main

import (
	"strings"
	"testing"
)

func TestPublicStatsNeverExportsKeysOrNetworkConfiguration(t *testing.T) {
	input := "private_key=secret-private\nlisten_port=123\npublic_key=public-one\npreshared_key=secret-shared\nrx_bytes=4\ntx_bytes=9\nendpoint=192.0.2.1:5\nallowed_ip=10.203.1.2/32\nlast_handshake_time_sec=77\nlast_handshake_time_nsec=42\n"
	got := publicStats(input)
	want := "public_key=public-one\nrx_bytes=4\ntx_bytes=9\nlast_handshake_time_sec=77\nlast_handshake_time_nsec=42\n"
	if got != want || strings.Contains(got, "secret") {
		t.Fatal("Statistics exposed unapproved configuration fields")
	}
}

func TestPublicStatsPreservesSeparatePeerCounters(t *testing.T) {
	input := "public_key=one\nrx_bytes=5\npublic_key=two\ntx_bytes=7\n"
	if publicStats(input) != input {
		t.Fatal("Peer counters changed")
	}
	if publicStats("private_key=secret\n") != "" {
		t.Fatal("Private key exported")
	}
}
