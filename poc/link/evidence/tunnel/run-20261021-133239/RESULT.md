# EasyTier tunnel PoC result (20261021-133239)

- backend: echo
- bind IP: 10.33.135.230 ; alias: 127.0.0.55 ; peer port: 64318
- host RPC: 64319 ; member RPC: 64320
- member local world port: 64321 (Minecraft would use --server 127.0.0.1 --port 64321)
- member local decoy port: 64322
- overall: True
- NAT type (EasyTier STUN): Unknown

## Steps
public-shared-node => True :: resolves=False tcp11010=False (expected NXDOMAIN from this network)
tun-mode-probe => True :: informational: denied=False (no denial captured); TUN is P1 and needs UAC
echo-server-direct => True :: echo on 127.0.0.55:25565
host-sidecar-start => True :: pid=27764 listener=tcp://10.33.135.230:64318 rpc=127.0.0.1:64319
p2p-peer-established => True :: host peer via tcp tunnel, nat=Unknown
echo-through-tunnel => True :: MCLPONG tunnel-20261021-133239 pid=7976 at=2026-10-21T05:32:54.038Z
decoy-port-not-exposed => True :: reply=
sidecar-listeners-scoped => True :: sidecars bind loopback/lan only (MC server itself binds *:25565 by design)

## Notes
- EasyTier 2.7.0, no-TUN mode, no Administrator required.
- Public shared node public.easytier.top did not resolve from this network (NXDOMAIN), so relay path is not exercised here.
- TUN mode failed with access denied (needs Administrator), captured in tun-probe logs.
- Logs, hashes and JSON live next to this file.
