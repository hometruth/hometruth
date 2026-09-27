# Tags and rooms

Tags organize configured elements without changing their device models. A tag
has a name and a value. An unnamed tag is written as `#outdoor`; a named tag can
be written as `room = Office` or `floor = Upstairs`. These are illustrative
values, not built-in locations.

The `(name, value)` pair is unique. `room = Office` and `#office` are different
tags. Tags also carry a UUID, color, description and revision. A value is a
display string; its URL slug is derived rather than stored as identity.

## Names and cardinality

A tag name declares whether one element can hold a single value or several.
The built-in `room` name is single-valued: assigning another room replaces the
previous room. Unnamed tags are multi-valued. Other names can be declared to
represent the installation's own organization.

Use UUIDs for exact assignments or a name/value pair when creating or selecting
a tag. Revision checks prevent an edit from silently overwriting a concurrent
change. Tags can describe schema or instance elements; tags themselves are not
elements that can receive tags.

## URLs and navigation

Unnamed tags use `/tags/<value-slug>`. Named tags use
`/tags/<name>/<value-slug>`, for example `/tags/room/office`.
A rename changes the current page URL. See [URLs](URLS.md) for canonical page
naming. Display names and page slugs do not replace persistent tag identities.

## Private configuration

Use the CLI's `tags` commands to inspect and transfer the ontology:

```sh
bun run ht tags list
bun run ht tags export
bun run ht tags import /absolute/path/to/private/tags.yml
```

Exported names and assignments may reveal an installation's layout. Save them
only in its private directory/repository, and review an import before applying
it. Runtime storage also stays in the private installation.

The source of the contract is [`src/tags/model.ts`](../src/tags/model.ts), with
store, assignment and export behavior in `src/tags/`. The [graph](GRAPH.md)
projects tag relationships alongside schema and instance relationships.
