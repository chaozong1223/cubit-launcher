# EasyTier tunnel PoC result (20261021-132438)

- backend: mc
- bind IP: 26.125.118.57 ; alias: 127.0.0.55 ; peer port: 52401
- host RPC: 52402 ; member RPC: 52403
- member local world port: 52404 (Minecraft would use --server 127.0.0.1 --port 52404)
- member local decoy port: 52405
- overall: False
- NAT type (EasyTier STUN): 

## Steps
public-shared-node => True :: resolves=False tcp11010=False (expected NXDOMAIN from this network)
tun-mode-probe => True :: informational: denied=False (no denial captured); TUN is P1 and needs UAC
mc-server-direct => False :: {"host":"127.0.0.1","port":25565,"latencyMs":615,"ok":false,"error":"closed before status"}
host-sidecar-start => True :: pid=3276 listener=tcp://26.125.118.57:52401 rpc=127.0.0.1:52402
fatal => False :: timeout waiting for member sees host peer (40s)

## Notes
- EasyTier 2.7.0, no-TUN mode, no Administrator required.
- Public shared node public.easytier.top did not resolve from this network (NXDOMAIN), so relay path is not exercised here.
- TUN mode failed with access denied (needs Administrator), captured in tun-probe logs.
- Logs, hashes and JSON live next to this file.
