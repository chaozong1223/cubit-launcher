# Room protocol PoC (2026-10-21T05-27-52-871Z)

- room code: V1AKXC (invite MCL-V1AKXC)
- control port: 65419
- ticket payload: `{"code":"V1AKXC","endpoints":[{"host":"127.0.0.1","kind":"lan","port":65419}],"exp":1792561072,"host":{"name":"poc-host","pub":"C1mCeyyz0JcUssdeimwvGgwwH3sDwgiph6i74C0een0"},"iat":1792560472,"jti":"fGcXBjrKYA8","max":2,"mc":{"loader":"vanilla","version":"1.20.1"},"net":{"name":"mcl-v1akxc","secret":"<redacted>"},"roomId":"VtynQN3dkxyNXAtUwi3ulg","tunnel":{"controlPort":25998,"mappedCidr":"192.168.77.1/32","provider":"easytier","version":"2.7.0","vip":"10.144.144.1","worldPort":25565},"v":1}`

| case | result | detail |
| --- | --- | --- |
| ticket-self-verifies | PASS | code=V1AKXC exp=1792561072 |
| normal-join | FAIL | connected=true worldUpdate=true elapsed=1548ms |
| short-code-incomplete | PASS | INVITE_INCOMPLETE only a 6-char code was provided; cross-network join needs the full MCL1 ticket |
| tampered-ticket-rejected | PASS | TICKET_SIGNATURE_INVALID signature verification failed |
| expired-ticket-rejected | PASS | INVITE_EXPIRED ticket expired |
| version-mismatch | PASS | VERSION_MISMATCH host 1.20.1/vanilla, member 1.20.4/vanilla |
| bad-token-rejected | PASS | AUTH_FAILED bad auth |
| room-full | PASS | ROOM_FULL max 2 |
| heartbeat-timeout | PASS | HEARTBEAT_TIMEOUT no PONG for 1200ms elapsed=1564ms |
| host-close-notifies-members | PASS | ROOM_CLOSED room closed: HOST_LEFT elapsed=522ms |
| join-after-close-fails | PASS | NETWORK_UNREACHABLE connect ECONNREFUSED 127.0.0.1:65419 |

**overall: FAIL**

Host events: host-events.jsonl; host output: host.out.log.