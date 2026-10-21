# Room protocol PoC (2026-10-21T05-27-44-842Z)

- room code: 0NRMWP (invite MCL-0NRMWP)
- control port: 56879
- ticket payload: `{"code":"0NRMWP","endpoints":[{"host":"127.0.0.1","kind":"lan","port":56879}],"exp":1792561064,"host":{"name":"poc-host","pub":"SdOmAZuFRzTV0yoyNI9VT9hgPo8pzxa1SvQ5o8U6WgU"},"iat":1792560464,"jti":"w9P158PEEig","max":2,"mc":{"loader":"vanilla","version":"1.20.1"},"net":{"name":"mcl-0nrmwp","secret":"<redacted>"},"roomId":"y5XxF_28VppR1EodMHKfWQ","tunnel":{"controlPort":25998,"mappedCidr":"192.168.77.1/32","provider":"easytier","version":"2.7.0","vip":"10.144.144.1","worldPort":25565},"v":1}`

| case | result | detail |
| --- | --- | --- |
| ticket-self-verifies | PASS | code=0NRMWP exp=1792561064 |
| normal-join | FAIL | connected=false worldUpdate=false elapsed=5ms |
| short-code-incomplete | PASS | INVITE_INCOMPLETE only a 6-char code was provided; cross-network join needs the full MCL1 ticket |
| tampered-ticket-rejected | PASS | TICKET_SIGNATURE_INVALID signature verification failed |
| expired-ticket-rejected | PASS | INVITE_EXPIRED ticket expired |
| version-mismatch | FAIL | AUTH_FAILED bad auth |
| bad-token-rejected | PASS | AUTH_FAILED bad auth |
| room-full | FAIL | AUTH_FAILED bad auth |
| heartbeat-timeout | FAIL | AUTH_FAILED bad auth elapsed=6ms |
| host-close-notifies-members | FAIL | AUTH_FAILED bad auth elapsed=5ms |
| join-after-close-fails | FAIL | AUTH_FAILED bad auth |

**overall: FAIL**

Host events: host-events.jsonl; host output: host.out.log.