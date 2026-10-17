/* SPDX-License-Identifier: Apache-2.0
 *
 * Copyright © 2017-2022 Jason A. Donenfeld <Jason@zx2c4.com>. All Rights Reserved.
 *
 * LinkUp modifications (2026-10-16): serialize native handle access, omit
 * debug signal/logging and the unused UAPI control socket, return public stats
 * only to Java. WireGuard protocol/cryptography stays in upstream wireguard-go.
 */

package main

// #cgo LDFLAGS: -llog
// #include <android/log.h>
import "C"

import (
	"math"
	"runtime/debug"
	"strings"
	"sync"

	"golang.org/x/sys/unix"
	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun"
)

type TunnelHandle struct {
	device *device.Device
}

var tunnelHandles = make(map[int32]TunnelHandle)
var handlesMutex sync.Mutex

//export wgTurnOn
func wgTurnOn(interfaceName string, tunFd int32, settings string) int32 {
	handlesMutex.Lock()
	defer handlesMutex.Unlock()
	logger := device.NewLogger(device.LogLevelSilent, "")

	tun, _, err := tun.CreateUnmonitoredTUNFromFD(int(tunFd))
	if err != nil {
		unix.Close(int(tunFd))
		logger.Errorf("CreateUnmonitoredTUNFromFD: %v", err)
		return -1
	}

	device := device.NewDevice(tun, conn.NewStdNetBind(), logger)

	err = device.IpcSet(settings)
	if err != nil {
		device.Close()
		logger.Errorf("IpcSet: %v", err)
		return -1
	}
	device.DisableSomeRoamingForBrokenMobileSemantics()

	err = device.Up()
	if err != nil {
		logger.Errorf("Unable to bring up device: %v", err)
		device.Close()
		return -1
	}
	logger.Verbosef("Device started")

	var i int32
	for i = 0; i < math.MaxInt32; i++ {
		if _, exists := tunnelHandles[i]; !exists {
			break
		}
	}
	if i == math.MaxInt32 {
		logger.Errorf("Unable to find empty handle")
		device.Close()
		return -1
	}
	tunnelHandles[i] = TunnelHandle{device: device}
	return i
}

//export wgTurnOff
func wgTurnOff(tunnelHandle int32) {
	handlesMutex.Lock()
	defer handlesMutex.Unlock()
	handle, ok := tunnelHandles[tunnelHandle]
	if !ok {
		return
	}
	delete(tunnelHandles, tunnelHandle)
	handle.device.Close()
}

//export wgGetSocketV4
func wgGetSocketV4(tunnelHandle int32) int32 {
	handlesMutex.Lock()
	defer handlesMutex.Unlock()
	handle, ok := tunnelHandles[tunnelHandle]
	if !ok {
		return -1
	}
	bind, _ := handle.device.Bind().(conn.PeekLookAtSocketFd)
	if bind == nil {
		return -1
	}
	fd, err := bind.PeekLookAtSocketFd4()
	if err != nil {
		return -1
	}
	return int32(fd)
}

//export wgGetSocketV6
func wgGetSocketV6(tunnelHandle int32) int32 {
	handlesMutex.Lock()
	defer handlesMutex.Unlock()
	handle, ok := tunnelHandles[tunnelHandle]
	if !ok {
		return -1
	}
	bind, _ := handle.device.Bind().(conn.PeekLookAtSocketFd)
	if bind == nil {
		return -1
	}
	fd, err := bind.PeekLookAtSocketFd6()
	if err != nil {
		return -1
	}
	return int32(fd)
}

//export wgGetConfig
func wgGetConfig(tunnelHandle int32) *C.char {
	handlesMutex.Lock()
	defer handlesMutex.Unlock()
	handle, ok := tunnelHandles[tunnelHandle]
	if !ok {
		return nil
	}
	settings, err := handle.device.IpcGet()
	if err != nil {
		return nil
	}
	return C.CString(publicStats(settings))
}

//export wgVersion
func wgVersion() *C.char {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return C.CString("unknown")
	}
	for _, dep := range info.Deps {
		if dep.Path == "golang.zx2c4.com/wireguard" {
			parts := strings.Split(dep.Version, "-")
			if len(parts) == 3 && len(parts[2]) == 12 {
				return C.CString(parts[2][:7])
			}
			return C.CString(dep.Version)
		}
	}
	return C.CString("unknown")
}

func main() {}
