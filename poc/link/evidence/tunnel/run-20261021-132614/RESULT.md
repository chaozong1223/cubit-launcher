# EasyTier tunnel PoC result (20261021-132614)

- backend: mc
- bind IP: 10.33.135.230 ; alias: 127.0.0.55 ; peer port: 52005
- host RPC: 52006 ; member RPC: 52007
- member local world port: 52008 (Minecraft would use --server 127.0.0.1 --port 52008)
- member local decoy port: 52009
- overall: True
- NAT type (EasyTier STUN): Unknown

## Steps
public-shared-node => True :: resolves=False tcp11010=False (expected NXDOMAIN from this network)
tun-mode-probe => True :: informational: denied=False (no denial captured); TUN is P1 and needs UAC
mc-server-direct => True :: {"host":"127.0.0.1","port":25565,"latencyMs":12,"ok":true,"version":"1.20.1","protocol":763,"players":{"online":0,"max":4},"motd":"MCL Tunnel PoC 1.20.1"}
host-sidecar-start => True :: pid=18420 listener=tcp://10.33.135.230:52005 rpc=127.0.0.1:52006
p2p-peer-established => True :: host peer via tcp tunnel, nat=Unknown
mc-status-through-tunnel => True :: {"host":"127.0.0.1","port":52008,"latencyMs":7,"ok":true,"version":"1.20.1","protocol":763,"players":{"online":0,"max":4},"motd":"MCL Tunnel PoC 1.20.1"}
decoy-port-not-exposed => True :: {"host":"127.0.0.1","port":52009,"latencyMs":5004,"ok":false,"error":"timeout"}
sidecar-listeners-scoped => True :: sidecars bind loopback/lan only (MC server itself binds *:25565 by design)

## Notes
- EasyTier 2.7.0, no-TUN mode, no Administrator required.
- Public shared node public.easytier.top did not resolve from this network (NXDOMAIN), so relay path is not exercised here.
- TUN mode failed with access denied (needs Administrator), captured in tun-probe logs.
- Logs, hashes and JSON live next to this file.
