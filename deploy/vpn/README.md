# LinkUp private network server setup

This setup connects enrolled Android phones through a WireGuard hub you control. LinkUp still encrypts messages end to end inside the tunnel. It provides explicit friend routes, not a public internet exit, anonymity service, or an audited communications system. No server is purchased, configured, or running as part of preparing these files.

The app accepts only individual `10.203.x.x/32` friend routes. The hub permits only authorized pairs on LinkUp's TLS service, TCP 47443, and its established replies. Mailboxes and calls are disabled in the app's private-network mode. Other apps and unrelated internet destinations are outside this VPN. DNS lookup of the hub uses the phone's usual resolver. The hub sees network metadata and encrypted application packets; it does not receive identity private keys or message decryption keys.

## Prepare public enrollments

Use a dedicated Linux server with a public IPv4 address or DNS name, systemd, WireGuard tools, nftables, Node 22 or newer, a correct synchronized clock, and SSH access. Open the chosen WireGuard UDP port, usually 51820, in the provider firewall and host firewall. Keep SSH restricted as appropriate. Do not use a server or LAN that already routes `10.203.0.0/16`.

In the new Android app, each friend opens **You → Connection → Private network → Create & copy public enrollment**. Exchange these enrollments with the administrator through a trusted channel and verify each LinkUp identity with its owner. The identity signature binds the independent phone WireGuard public key to that account. An enrollment is valid for seven days. Accepting a signed enrollment does not, by itself, decide that a person is your friend.

Generate the hub key **on the server**, as root. These commands deliberately refuse to replace an existing key:

```sh
set -eu
install -d -m 700 /etc/wireguard
umask 077
test ! -e /etc/wireguard/linkup.key
wg genkey > /etc/wireguard/linkup.key
wg pubkey < /etc/wireguard/linkup.key > /etc/wireguard/linkup-public.txt
```

The `set -eu` guard stops before overwriting an existing key. Keep `linkup.key` private. Only `linkup-public.txt` is needed by the preparation tool.

Create a `policy.json` containing the signed enrollment objects and explicit allowed pairs. Replace the explanatory placeholders below with actual public data; do not add a private key. Set `expiresAt` to a Unix timestamp in milliseconds no more than seven days ahead.

```json
{
  "schema": 1,
  "label": "Our friends",
  "endpoint": "vpn.example.org:51820",
  "expiresAt": 0,
  "devices": ["REPLACE_WITH_SIGNED_ENROLLMENT_OBJECT_A", "REPLACE_WITH_SIGNED_ENROLLMENT_OBJECT_B"],
  "friends": [["ACCOUNT_IDENTITY_A", "ACCOUNT_IDENTITY_B"]]
}
```

The example domain is a placeholder. Keep device ordering stable when renewing; addresses are assigned in that order. The preparation tool checks signatures, timestamps, duplicate devices, pair membership, endpoint syntax, route scope, and expiry. It refuses to overwrite an existing output directory.

```sh
node deploy/vpn/prepare.mjs policy.json /etc/wireguard/linkup-public.txt vpn-output
node --test deploy/vpn/config.test.mjs
```

Preparation writes public phone configurations, a hub configuration, a dedicated firewall table, and enrollment-expiry services. It does not change interfaces, start services, or modify the firewall.

## Install on the server

Review the generated files, keep an SSH session available, and validate the nftables syntax before applying it. The rules replace only the dedicated `linkup_vpn` table, never the host's entire firewall. Existing host rules may still need an explicit allowance for the authorized WireGuard forwarding paths. Do not add a broad internet-forwarding or NAT rule.

As root, from the repository directory on the server:

```sh
set -eu
install -m 600 vpn-output/wg-linkup.conf /etc/wireguard/wg-linkup.conf
install -m 600 vpn-output/linkup.nft /etc/wireguard/linkup.nft
nft --check --file /etc/wireguard/linkup.nft
install -m 700 vpn-output/linkup-vpn-check /usr/local/sbin/linkup-vpn-check
install -m 644 vpn-output/linkup-vpn-expire.service /etc/systemd/system/
install -m 644 vpn-output/linkup-vpn-expire.timer /etc/systemd/system/
install -d -m 755 /etc/systemd/system/wg-quick@wg-linkup.service.d
install -m 644 vpn-output/wg-linkup-guard.conf /etc/systemd/system/wg-quick@wg-linkup.service.d/enrollment.conf
printf 'net.ipv4.ip_forward=1\n' > /etc/sysctl.d/90-linkup-vpn.conf
sysctl -p /etc/sysctl.d/90-linkup-vpn.conf
systemctl daemon-reload
systemctl enable --now linkup-vpn-expire.timer
systemctl enable --now wg-quick@wg-linkup.service
```

The private key is read locally by `wg set`; it is never inserted into the generated public configurations. The server refuses startup after enrollment expiry, and a persistent systemd timer stops the interface when the policy expires. Phones enforce expiry independently. The timer disables systemd’s default one-minute coalescing window and random delay. Correct server time is necessary for expiry enforcement; OS scheduling and system load still preclude a hard real-time cutoff. Verify the timer is scheduled with `systemctl list-timers linkup-vpn-expire.timer`.

Send each `<account identity>.json` only to its corresponding phone owner. They paste it into **Private network**, save it, verify the hub key and server address with you, and tap **Connect private network**. Android asks for VPN permission. One active VPN is allowed per Android profile; this may replace an existing VPN. This integration does not auto-enable Android's always-on or block-without-VPN settings.

## Connect friends and verify

Both phones must use the new app, add each other through LinkUp invitations, and connect the enrolled private network. One selects the other friend and taps **Start private connection**. Send or scan that signed, short-lived connection code on the other phone. It pins the selected friend's identity, overlay address and TLS certificate. The QR code contains public connection details, not private keys.

Test with two phones on different internet connections:

1. Verify each tunnel is up and both phones exchange messages in both directions. A tunnel interface being up is not proof that the hub or peer is reachable. Check `wg show wg-linkup latest-handshakes` on the hub without exporting private configuration.
2. Block the hub UDP port or stop the tunnel. Messages must remain queued; mailbox, Wi-Fi and cellular fallback must not deliver them. Reconnect and create a new friend session to resume.
3. Revoke VPN consent, lock LinkUp, remove the app from recents, and expire the configuration. Confirm the tunnel and private friend sockets stop as intended on each supported Android version.
4. Enroll a third phone without granting it a particular pair. Confirm the hub rejects that pair, other phone ports, hub management addresses, and internet destinations through the tunnel.
5. Reset one LinkUp account. Its local VPN key and configuration must be erased; its old enrollment must not restore access to the new account. Remove the old device from the hub policy as well.
6. Confirm Android screenshots and recents previews hide LinkUp content. Test notifications separately; their opt-in background-key access is a distinct trust boundary and private-network messaging is foreground-only.

These checks require actual devices and a deployed hub. Local unit tests and a successful APK build do not establish cross-network operation or eliminate security defects.

## Renew or revoke

Stop `wg-quick@wg-linkup.service` before replacing peer lists. Remove revoked devices and pairs from the policy, obtain fresh signed enrollments as needed, set a new expiry, and generate a fresh output directory. Install the new configurations and expiry files, run `systemctl daemon-reload`, restart the expiry timer, then start the interface. Distribute each updated phone configuration. Replacing the full peer list removes revoked public keys; a previously connected device must not retain a stale live peer entry.

Store the hub private key at mode 0600 in its private directory. Do not commit generated operational policies or keys. Do not enable packet captures or verbose per-user logs by default. Source code and public templates belong in the repository; deploy-specific material belongs in a protected directory outside release archives.

The official [WireGuard quick start](https://www.wireguard.com/quickstart/) documents key creation and keepalives. [Android VPN documentation](https://developer.android.com/develop/connectivity/vpn) describes consent and routing. See [LinkUp security status](../../app/SECURITY.md) for the unaudited MLS implementation, endpoint and metadata limitations, and release gates.
