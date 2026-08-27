# pi-service-tier

Service-tier selection for Pi OpenAI requests.

Command `/tier default|flex|priority` persists to agent dir. `applyTierToPayload` sets `service_tier: flex|priority` or omits for default. Cost multiplier `default 1, flex 0.5, priority 2 (2.5 for gpt-5.5)`. Wraps OpenAI provider `stream`/`streamSimple` via `onPayload` and scales `usage.cost`.

Registered via `pi.registerProvider` wrapping live base, preserves catalog.
