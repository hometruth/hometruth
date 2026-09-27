# State and rendering

The state service owns domain data: configuration, inventory, relationships, observed values, faults, and observation times. It does not own HTML, page layouts, view models, or raster images.

`StateHub.graph` holds observed records. `StateHub.data` holds configuration and inventory and exposes the indexed topology. SQLite and configuration files provide persistence; they are read during bootstrap or explicit background refresh. Successful configuration writes update the in-memory data before returning.

Page handlers construct HTML from that data synchronously. A missing record renders Unknown. A failed refresh retains the last known value beside its fault and timestamp. A renderer must never call a device's `describe()`, discover sensors, load a configuration file, or rasterize a preview to obtain its initial content. Graph construction is a pure projection of cached inputs. Changes to configuration or discovered identities invalidate topology; changed measurements alone do not.

The observer retains enabled devices independently of browser subscriptions. It applies bounded concurrency, polling floors, push invalidation, and failure backoff. Explicit descriptions and command results publish through the same observer. Browser streams deliver subsequent observations; loss of the runtime connection leaves cached content and edits visible with a connection notice.

`GET /api/state` returns cached observations. Repeated `node` parameters select a subset; omission returns all records in the caller's scope. `/api/graph` and `/api/graph/:key` project cached topology. Presentation code remains responsible for formatting these records.

Kindle HTML is rendered directly from cached records. The explicit canvas-preview endpoint can rasterize later. Camera media, experiments, and explicit refresh/control operations may perform their required I/O outside initial page rendering.

The regression tests in `src/server/cached-rendering.test.ts` deliberately leave device and storage reads unresolved, then request ordinary HTML and graph routes. Rendering must complete without starting additional reads. `src/state/data.test.ts` checks configuration races, identity retention, and cache invalidation.

Initial HTML includes all data used by the page: readings, tags and assignments, search and filter choices, rooms, settings, and cached event rows. Hydration attaches handlers to that content. It must not fetch a catalog, describe a device, clear existing rows, or replace them with Loading/Checking. Tags search and pagination operate on the shipped snapshot. Streams and later explicit refreshes keep visible content in place.

The request takes one observation snapshot, indexed by node ID. Inventory indexes update at publication; topology reads do not rescan sensors. Event histories and network-client inventory are refreshed outside requests. Presentation catalogs, API contracts/panels, and locale formatters have separate caches outside the state service, invalidated by the configuration or action limits they depend on. CSP nonces remain unique to each response.
