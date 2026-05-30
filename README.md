# Distributed Job Dispatcher

Take-home for Dizzaract / FarLabs. Three coordinators behind nginx + five workers connecting outbound over WebSocket, backed by Postgres. Survives the supplied chaos harness with zero invariant violations.

See [DECISIONS.md](DECISIONS.md) for the five design decisions and [chaos_report.txt](chaos_report.txt) for the harness output.

## Quick start

```bash
make up        # build images, start stack, run migrations
make chaos     # run the supplied harness → chaos_report.txt
make down      # tear everything down
```

The stack is reachable on `http://localhost:8080` (nginx round-robin across three coordinators).

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/jobs` | Submit a job. Body: `{ idempotency_key, payload }`. Returns existing job if key seen. |
| `GET` | `/jobs/:id` | Query job state. |
| `DELETE` | `/jobs/:id` | Cancel an unstarted (PENDING) job. |
| `GET` | `/jobs/:id/stream` | SSE stream of state transitions until terminal. |
| `GET` | `/stats` | Plain-text operator report (workers, queue, leases, last 60s). |
| `POST` | `/chaos` | Inject a fault. Body: `{ fault, params }`. See §3.6 of the brief. |
| `POST` | `/workers/:workerId/concurrency` | Change a worker's concurrency limit at runtime (no restart). |
| `GET` | `/audit` | Audit log used by the harness for post-run invariant checks. |

Try them:
```bash
curl -s localhost:8080/stats
curl -s -X POST localhost:8080/jobs -H 'content-type: application/json' \
  -d '{"idempotency_key":"demo-1","payload":{"sleepMs":200}}'
curl -s -X POST localhost:8080/chaos -H 'content-type: application/json' \
  -d '{"fault":"pause_dispatch","params":{"ms":2000}}'
```

## Topology

```
                ┌──────────────────────┐
   client ───►  │ nginx (round-robin)  │
                └──────────────────────┘
                          │
       ┌──────────────────┼──────────────────┐
       ▼                  ▼                  ▼
   coord-1            coord-2            coord-3
       │                  │                  │
       └────────────┬─────┴────────┬─────────┘
                    ▼              ▼
                 Postgres       Postgres
                 (jobs,leases,fencing_seq,audit)

      ▲  ▲  ▲  ▲  ▲      ← outbound WebSocket
      │  │  │  │  │
    w-1 w-2 w-3 w-4 w-5  (5 workers)
```

- Coordinators are **leaderless peers**. Dispatch races are resolved by `FOR UPDATE SKIP LOCKED`.
- Fencing tokens come from a single Postgres `BIGSERIAL` (`fencing_seq`), issued atomically with `pg_advisory_xact_lock`. Globally monotonic across restarts and replicas.
- Workers send `job.heartbeat` every 5s; the coordinator extends `Lease.ExpiresAt` only if `(jobId, workerId, token)` matches. Lease TTL = 15s. Lease reaper runs every 5s on every coordinator.

## Repo layout

```
src/
  coordinator/
    db/              # TypeORM entities + repos (audit tables: lease-history, job-transition, commit-attempt)
    routes/          # jobs, stats, chaos, workers, audit
    services/        # dispatch, lease-reaper, worker-hub, chaos
    server.ts        # Express + WS setup
  worker/            # WS client, executor, heartbeat loop
  shared/            # protocol enums, job-status enum, errors
  db/migrations/     # initial schema + audit tables
docker-compose.yml   # nginx + postgres + 3 coords + 5 workers
nginx.conf           # round-robin upstream with failover
Dockerfile.coordinator
Dockerfile.worker
chaos_harness.py     # supplied, do not modify
chaos_report.txt     # final 10-minute harness run, zero violations
DECISIONS.md         # 5 design decisions
Makefile             # up, down, chaos, test, migrate, …
```

## Make targets

```
make up               build images and start full stack
make down             stop stack and remove volumes
make chaos            run the chaos harness → chaos_report.txt
make logs             tail logs for all services
make test             smoke test (tsc --noEmit) + biome check
make migrate          run pending DB migrations
make coordinator-dev  start a single coordinator locally for development
make check / format   biome lint / format
```

## Failure-mode summary

| Failure | Detected via | Recovery time |
|---|---|---|
| Worker SIGKILL | heartbeats stop → lease TTL expires | ≤ 15s TTL + ≤ 5s reaper = **≤ 20s** |
| Coordinator SIGKILL | nginx `proxy_next_upstream` retries on another coord | < 1s (single client request) |
| Worker network blip | WS reconnect to any coord via nginx; heartbeats resume | 0s if blip < 15s |
| Both coordinator and worker SIGKILL | same as worker — heartbeats stop, lease expires | ≤ 20s |

All within the harness's 45s drain window.

## Notes

- Job duration is bimodal: 100–500ms (~95%) and 5–30s (~5%). Heartbeats keep long jobs' leases alive.
- Idempotency is enforced by `UNIQUE(IdempotencyKey)` at the DB level — race-free even across coordinators in the same millisecond.
- The four required chaos faults (`pause_dispatch`, `drop_acks`, `clock_skew`, `partition_db`) are in [src/coordinator/services/chaos.service.ts](src/coordinator/services/chaos.service.ts).
