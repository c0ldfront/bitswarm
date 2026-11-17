import { timingSafeEqual } from "node:crypto";
import {
  assert,
  digest,
  isHash,
  MAX_BLOB,
  MAX_EVENTS,
  type Event,
} from "./core.ts";
import { Store } from "./store.ts";
import { peerOrigin } from "./link.ts";
import {
  authenticate,
  credentials,
  authHeaders,
  type Grant,
  type Auth,
} from "./access.ts";

export function requireToken(token: string): void {
  assert(
    token.length >= 32,
    "Set BITSWARM_TOKEN to a shared secret of at least 32 characters",
  );
}
export async function limited(
  response: Response | Request,
  max: number,
): Promise<Uint8Array> {
  assert(
    Number(response.headers.get("content-length") || 0) <= max,
    "Body too large",
  );
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      assert(size <= max, "Body too large");
      chunks.push(value);
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  }
  return Buffer.concat(chunks);
}
const rates = new Map<string, { window: number; requests: number }>();
export async function handle(
  store: Store,
  token: string,
  req: Request,
): Promise<Response> {
  try {
    const url = new URL(req.url),
      path = url.pathname;
    if (
      req.method === "GET" &&
      path === "/v1/public-preview" &&
      store.manifest.preview
    )
      return Response.json({
        swarm: digest(store.manifest),
        summary: store.manifest.preview,
      });
    const bytes = await limited(req, MAX_BLOB);
    const auth = req.headers.get("authorization") || "";
    let member: { key: string; role: string; grant?: Grant };
    const g = store.governance();
    if (auth.startsWith("Swarm "))
      member = authenticate(store, auth, req.method, path + url.search, bytes);
    else {
      const expected = Buffer.from("Bearer " + token),
        supplied = Buffer.from(auth);
      if (
        store.manifest.restricted ||
        ["invite", "public"].includes(g.manifest.policy?.admission || "") ||
        token.length < 32 ||
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      )
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      member = { key: "shared", role: "trusted" };
    }
    const rateKey = digest(store.manifest) + ":" + member.key;
    let rate = rates.get(rateKey);
    if (!rate || Date.now() - rate.window > 60_000) {
      rate = { window: Date.now(), requests: 0 };
      rates.set(rateKey, rate);
    }
    if (++rate.requests > (g.manifest.policy?.requestsPerMinute ?? 2400))
      return Response.json(
        { error: "Contributor rate limit exceeded" },
        {
          status: 429,
          headers: {
            "retry-after": String(
              Math.max(1, Math.ceil((rate.window + 60000 - Date.now()) / 1000)),
            ),
          },
        },
      );
    if (rates.size > 10_000)
      for (const [key, value] of rates)
        if (Date.now() - value.window > 60_000) rates.delete(key);
    let readable: Set<string> | undefined;
    if (
      store.manifest.restricted &&
      member.key !== g.planner &&
      !store.manifest.validators.includes(member.key)
    ) {
      const blocks = g.manifest.blocks.filter((b) =>
        member.grant?.blocks?.includes(b.id),
      );
      readable = store.expandRoots([
        ...blocks.flatMap((b) => [...b.inputs, ...(b.optionalInputs ?? [])]),
        ...(member.grant?.roots ?? []),
      ]);
    }
    const outputs =
      store.participation()?.upload === "results"
        ? store.ownOutputs()
        : undefined;
    const canServe = (id: string) =>
      (!outputs || outputs.has(id)) && (!readable || readable.has(id));
    if (req.method === "GET" && path === "/v1/preview") {
      return Response.json({
        swarm: digest(store.manifest),
        goal: g.manifest.description,
        tasks: store.state().map(({ block, status }) => {
          const ids = store.expandRoots(block.inputs);
          let bytes: number | null = 0;
          for (const id of ids) {
            const size = (
              store.db
                .query("SELECT length(body) AS size FROM blobs WHERE id=?")
                .get(id) as { size: number } | null
            )?.size;
            if (size === undefined) {
              bytes = null;
              break;
            }
            bytes += size;
          }
          return {
            id: block.id,
            title: block.title,
            status,
            requires: block.requires,
            capabilities: block.capabilities,
            declaredInputBytes: bytes,
            output: block.contract?.schema,
            verifier: block.contract?.verifier,
            maxTokens: block.contract?.maxTokens,
          };
        }),
      });
    }
    if (req.method === "GET" && path === "/v1/manifest")
      return Response.json(store.manifest);
    if (req.method === "GET" && path === "/v1/wants") {
      const wanted = store.wanted(),
        cap = store.participation()?.downloadBytes;
      return Response.json({
        // A results-only mirror pulls. Its filtered inventory cannot advertise cached inputs as present.
        ids: wanted
          ? [...wanted].filter((id) => !store.hasBlob(id))
          : outputs
            ? []
            : null,
        remainingBytes:
          cap === undefined
            ? null
            : Math.max(0, cap - store.usedBytes("download")),
      });
    }
    if (req.method === "GET" && path === "/v1/peers")
      return Response.json({ peers: store.peers() });
    if (req.method === "GET" && path === "/v1/inventory") {
      const inventory = store.inventory();
      inventory.blobs = inventory.blobs.filter(canServe);
      const after = url.searchParams.get("after") || "";
      const type = url.searchParams.get("type");
      if (type === "events" || type === "blobs") {
        const ids = inventory[type].filter((id) => id > after).slice(0, 256);
        return Response.json({
          swarm: inventory.swarm,
          ids,
          next: ids.length === 256 ? ids[ids.length - 1] : null,
        });
      }
      return Response.json(inventory);
    }
    const match = /^\/v1\/(events|blobs)\/([a-f0-9]{64})$/.exec(path);
    if (!match) return Response.json({ error: "Not found" }, { status: 404 });
    const [, kind, id] = match;
    if (req.method === "GET") {
      if (kind === "blobs" && !canServe(id))
        return Response.json({ error: "Object unavailable" }, { status: 404 });
      const value = kind === "events" ? store.event(id) : store.blob(id);
      if (!value) return Response.json({ error: "Not found" }, { status: 404 });
      if (kind === "blobs") {
        const max = url.searchParams.get("maxBytes");
        if (
          max !== null &&
          (!/^\d+$/.test(max) || (value as Uint8Array).length > Number(max))
        )
          return Response.json(
            { error: "Object exceeds requested payload limit" },
            { status: 413 },
          );
        store.charge("upload", (value as Uint8Array).length);
      }
      return kind === "events"
        ? Response.json(value)
        : new Response(Buffer.from(value as Uint8Array), {
            headers: { "content-type": "application/octet-stream" },
          });
    }
    if (req.method === "PUT") {
      assert(member.role !== "reader", "Read-only contributor");
      if (kind === "events") {
        assert(bytes.length <= 32_768, "Event too large");
        const event = JSON.parse(Buffer.from(bytes).toString()) as Event;
        assert(event.id === id, "Event ID mismatch");
        // Workers may relay signed statements from others; authority is checked by projection.
        store.addEvent(event);
      } else {
        assert(
          !store.manifest.restricted,
          "Restricted payloads use authenticated pulls",
        );
        const wanted = store.wanted();
        assert(!wanted || wanted.has(id), "Object outside local selection");
        const usage = store.db
          .query(
            "SELECT COALESCE(SUM(bytes),0) AS n FROM blob_owners WHERE author=?",
          )
          .get(member.key) as { n: number };
        assert(
          store.hasBlob(id) ||
            usage.n + bytes.length <=
              (g.manifest.policy?.uploadBytes ?? 32 * MAX_BLOB),
          "Contributor blob quota exceeded",
        );
        store.db
          .transaction(() => {
            store.charge("download", bytes.length);
            store.addBlob(bytes, id);
          })
          .immediate();
        store.db
          .query("INSERT OR IGNORE INTO blob_owners VALUES (?,?,?)")
          .run(id, member.key, bytes.length);
      }
      store.transfer("received", bytes.length);
      return Response.json({ id });
    }
    return new Response("Method not allowed", { status: 405 });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Invalid request" },
      { status: 400 },
    );
  }
}
export function serve(
  store: Store,
  token: string,
  port = 7331,
  hostname = "127.0.0.1",
) {
  if (
    !["invite", "public"].includes(
      store.governance().manifest.policy?.admission || "",
    )
  )
    requireToken(token);
  return Bun.serve({
    hostname,
    port,
    maxRequestBodySize: MAX_BLOB,
    fetch: (req) => handle(store, token, req),
  });
}
export type RemoteTransport = (
  peer: string,
  path: string,
  init: RequestInit,
  max: number,
) => Promise<Uint8Array>;
const meshTransports = new Map<string, RemoteTransport>();
export function setMeshTransport(
  transport: RemoteTransport | undefined,
  key = "default",
) {
  if (transport) meshTransports.set(key, transport);
  else meshTransports.delete(key);
}
export async function request(
  peer: string,
  auth: Auth,
  path: string,
  init: RequestInit = {},
  max = 2 * MAX_BLOB,
): Promise<Uint8Array> {
  const body =
    typeof init.body === "string"
      ? Buffer.from(init.body)
      : init.body instanceof Uint8Array
        ? init.body
        : new Uint8Array();
  const prepared = {
    ...init,
    headers: {
      ...init.headers,
      ...authHeaders(auth, init.method || "GET", path, body),
    },
  };
  if (peer.startsWith("libp2p:")) {
    const meshTransport =
      meshTransports.get(
        typeof auth === "string" ? "default" : auth.identity.publicKey,
      ) || meshTransports.get("default");
    assert(meshTransport, "Start a mesh node to use libp2p peers");
    return meshTransport(peer, path, prepared, max);
  }
  const url = new URL(peerOrigin(peer));
  const response = await fetch(new URL(path, url), {
    ...prepared,
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });
  if (!response.ok) {
    let detail = "";
    try {
      const error = JSON.parse(
        Buffer.from(await limited(response, 4096)).toString(),
      );
      if (typeof error.error === "string")
        detail =
          ": " + error.error.slice(0, 200).replace(/[\x00-\x1f\x7f]/g, " ");
    } catch {}
    throw new Error("Peer returned HTTP " + response.status + detail);
  }
  return limited(response, max);
}
export async function getManifest(peer: string, auth: Auth) {
  return JSON.parse(
    Buffer.from(
      await request(peer, auth, "/v1/manifest", {}, MAX_BLOB),
    ).toString(),
  );
}
async function inventory(
  peer: string,
  auth: Auth,
  type: "events" | "blobs",
  swarm: string,
): Promise<string[]> {
  let after = "",
    ids: string[] = [];
  for (let n = 0; n < 41; n++) {
    const page = JSON.parse(
      Buffer.from(
        await request(peer, auth, `/v1/inventory?type=${type}&after=${after}`),
      ).toString(),
    );
    assert(
      page.swarm === swarm &&
        Array.isArray(page.ids) &&
        page.ids.length <= 256 &&
        page.ids.every(isHash),
      "Invalid inventory",
    );
    assert(
      page.ids.every(
        (id: string, i: number) => id > (i ? page.ids[i - 1] : after),
      ),
      "Unsorted inventory",
    );
    ids.push(...page.ids);
    assert(ids.length <= MAX_EVENTS, "Inventory exceeds limit");
    if (!page.next) return ids;
    assert(
      page.next === page.ids.at(-1) && page.next > after,
      "Invalid inventory cursor",
    );
    after = page.next;
  }
  throw new Error("Inventory pagination limit exceeded");
}
export async function sync(
  store: Store,
  peer: string,
  auth: Auth,
  options: {
    blocks?: string[];
    metadataOnly?: boolean;
    discover?: boolean;
  } = {},
): Promise<{ pulled: number; pushed: number; invalid: number }> {
  if (options.blocks || options.metadataOnly) {
    const profile = store.participation();
    if (profile)
      store.configure({
        ...profile,
        download: options.blocks ? "tasks" : "metadata",
        ...(options.blocks ? { only: options.blocks } : {}),
      });
    else store.select(options.blocks || []);
  }
  peer = peerOrigin(peer);
  store.rememberPeer(peer);
  let pulled = 0,
    pushed = 0,
    invalid = 0;
  const remote = {
    events: await inventory(peer, auth, "events", digest(store.manifest)),
    blobs: await inventory(peer, auth, "blobs", digest(store.manifest)),
  };
  const blocked = store.quarantined(peer);
  for (const kind of ["events", "blobs"] as const) {
    const local = store.inventory();
    const own = new Set(local[kind]),
      theirs = new Set(remote[kind]);
    const desired = kind === "blobs" ? store.wanted() : undefined;
    const offer =
      kind === "blobs"
        ? JSON.parse(
            Buffer.from(await request(peer, auth, "/v1/wants")).toString(),
          )
        : null;
    const wants = kind === "blobs" ? offer.ids : null;
    let remaining = offer?.remainingBytes ?? Number.MAX_SAFE_INTEGER;
    assert(
      Number.isSafeInteger(remaining) && remaining >= 0,
      "Invalid peer download budget",
    );
    assert(
      wants === null ||
        (Array.isArray(wants) && wants.length <= 10_000 && wants.every(isHash)),
      "Invalid wanted-object list",
    );
    const receive = [...theirs]
      .filter(
        (id) =>
          !own.has(id) && !blocked.has(id) && (!desired || desired.has(id)),
      )
      .slice(0, 100);
    const outputs =
      kind === "blobs" && store.participation()?.upload === "results"
        ? store.ownOutputs()
        : undefined;
    const send = (kind === "blobs" && store.manifest.restricted ? [] : [...own])
      .filter((id) => !outputs || outputs.has(id))
      .filter((id) => !theirs.has(id) && (!wants || wants.includes(id)))
      .slice(0, 100);
    for (const id of receive)
      try {
        const cap = store.participation()?.downloadBytes;
        const max =
          kind === "events"
            ? 32768
            : Math.min(
                MAX_BLOB,
                Math.max(
                  0,
                  (cap ?? Number.MAX_SAFE_INTEGER) -
                    store.usedBytes("download"),
                ),
              );
        if (kind === "blobs" && max === 0) break;
        const query =
          kind === "blobs" && cap !== undefined ? "?maxBytes=" + max : "";
        const data = await request(
          peer,
          auth,
          `/v1/${kind}/${id}` + query,
          {},
          max,
        );
        if (kind === "events") {
          const e = JSON.parse(Buffer.from(data).toString());
          assert(e.id === id, "Event ID mismatch");
          store.addEvent(e);
        } else
          store.db
            .transaction(() => {
              store.charge("download", data.length);
              store.addBlob(data, id);
            })
            .immediate();
        pulled++;
        store.transfer("pulled", data.length);
      } catch (e) {
        if (
          e instanceof Error &&
          /hash mismatch|event hash|signature|Event ID mismatch/i.test(
            e.message,
          )
        )
          store.quarantine(peer, id, e.message);
        invalid++;
      }
    for (const id of send)
      try {
        const body =
          kind === "events"
            ? JSON.stringify(store.event(id))
            : Buffer.from(store.blob(id)!);
        if (kind === "blobs") {
          if (body.length > remaining) continue;
          remaining -= body.length;
          store.charge("upload", body.length);
        }
        await request(peer, auth, `/v1/${kind}/${id}`, { method: "PUT", body });
        pushed++;
        store.transfer("pushed", Buffer.byteLength(body));
      } catch (e) {
        invalid++;
      }
  }
  if (options.discover) {
    const info = JSON.parse(
      Buffer.from(await request(peer, auth, "/v1/peers")).toString(),
    );
    assert(
      Array.isArray(info.peers) && info.peers.length <= 32,
      "Invalid peer hints",
    );
    for (const hint of info.peers) store.rememberPeer(peerOrigin(hint));
  }
  store.trimHistory();
  return { pulled, pushed, invalid };
}

export async function hydrateTask(
  store: Store,
  id: string,
  complete: () => boolean,
) {
  const profile = store.participation();
  if (!profile) return;
  assert(
    profile.download !== "metadata" &&
      (!profile.only || profile.only.includes(id)),
    "Task outside local participation scope",
  );
  if (profile.download === "tasks") store.subscribe(id);
  for (let round = 0; round < 105 && !complete(); round++) {
    let progress = 0;
    for (const peer of store.peers()) {
      try {
        progress += (
          await sync(
            store,
            peer,
            credentials(store, process.env.BITSWARM_TOKEN || ""),
          )
        ).pulled;
      } catch (error) {
        console.error("Task input sync: " + String(error));
      }
      if (complete()) return;
    }
    if (!progress) break;
  }
}
