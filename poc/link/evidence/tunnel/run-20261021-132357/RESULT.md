# EasyTier tunnel PoC result (20261021-132357)

- backend: mc
- bind IP: 26.125.118.57 ; alias: 127.0.0.55 ; peer port: 58896
- host RPC: 58897 ; member RPC: 58898
- member local world port: 58899 (Minecraft would use --server 127.0.0.1 --port 58899)
- member local decoy port: 58900
- overall: False
- NAT type (EasyTier STUN): 

## Steps
public-shared-node => True :: resolves=False tcp11010=False (expected NXDOMAIN from this network)
tun-mode-probe => False :: TUN requires admin: False
fatal => False :: missing Java: D:\DSH-宸ヤ綔鏂囦欢\tools\jdk21\jdk-21.0.12.1+1\bin\java.exe

## Notes
- EasyTier 2.7.0, no-TUN mode, no Administrator required.
- Public shared node public.easytier.top did not resolve from this network (NXDOMAIN), so relay path is not exercised here.
- TUN mode failed with access denied (needs Administrator), captured in tun-probe logs.
- Logs, hashes and JSON live next to this file.
