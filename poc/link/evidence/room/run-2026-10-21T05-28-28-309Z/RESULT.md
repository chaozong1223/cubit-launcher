# Room protocol PoC (2026-10-21T05-28-28-309Z)

- room code: 4SA2XE (invite MCL-4SA2XE)
- control port: 59131
- ticket payload: `{"code":"4SA2XE","endpoints":[{"host":"127.0.0.1","kind":"lan","port":59131}],"exp":1792561108,"host":{"name":"poc-host","pub":"4CTbt5ap4oPeL1vqgTO3pMqJi_VeBxy3ZiV5C9hk0oA"},"iat":1792560508,"jti":"oxWQpLPhnSM","max":2,"mc":{"loader":"vanilla","version":"1.20.1"},"net":{"name":"mcl-4sa2xe","secret":"<redacted>"},"roomId":"Z4NMf-M537oIbLqpepQDLA","tunnel":{"controlPort":25998,"mappedCidr":"192.168.77.1/32","provider":"easytier","version":"2.7.0","vip":"10.144.144.1","worldPort":25565},"v":1}`

| case | result | detail |
| --- | --- | --- |
| ticket-self-verifies | PASS | code=4SA2XE exp=1792561108 |
| normal-join | PASS | connected=true worldUpdate=true elapsed=2508ms |
| short-code-incomplete | PASS | INVITE_INCOMPLETE only a 6-char code was provided; cross-network join needs the full MCL1 ticket |
| tampered-ticket-rejected | PASS | TICKET_SIGNATURE_INVALID signature verification failed |
| expired-ticket-rejected | PASS | INVITE_EXPIRED ticket expired |
| version-mismatch | PASS | VERSION_MISMATCH host 1.20.1/vanilla, member 1.20.4/vanilla |
| bad-token-rejected | PASS | AUTH_FAILED bad auth |
| room-full | PASS | ROOM_FULL max 2 |
| heartbeat-timeout | PASS | HEARTBEAT_TIMEOUT no PONG for 1200ms elapsed=1560ms |
| host-close-notifies-members | PASS | ROOM_CLOSED room closed: HOST_LEFT elapsed=511ms |
| join-after-close-fails | PASS | NETWORK_UNREACHABLE connect ECONNREFUSED 127.0.0.1:59131 |

**overall: PASS**

Host events: host-events.jsonl; host output: host.out.log.