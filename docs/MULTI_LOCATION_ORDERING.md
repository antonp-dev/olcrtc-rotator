# Client locations and ordering

This document describes how multiple locations work for one client, especially the difference between the API order, runtime order, subscription order, and the order shown in the admin panel.

## Data model

A client owns an ordered JSON array:

```json
{
  "client-id": "alice",
  "locations": [
    {
      "name": "Primary Telemost",
      "endpoint": {
        "room_id": "telemost-room-1",
        "key": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      },
      "carrier": "telemost",
      "transport": {
        "type": "vp8channel"
      }
    },
    {
      "name": "Backup Telemost",
      "endpoint": {
        "room_id": "telemost-room-2",
        "key": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      },
      "carrier": "telemost",
      "transport": {
        "type": "vp8channel"
      }
    }
  ]
}
```

The array position is meaningful for ordering, but there is no special primary location. Every location is an independent `olcrtc` instance.

## Creating a client

`POST /api/clients` accepts a `locations` array. The locations are validated and appended to the new client in exactly the order received:

```http
POST /api/clients
Content-Type: application/json

{
  "client_id": "alice",
  "locations": [
    { "name": "Second", "room_id": "room-2", "key": "...64 hex characters...", "carrier": "telemost", "transport": "vp8channel" },
    { "name": "First", "room_id": "room-1", "key": "...64 hex characters...", "carrier": "telemost", "transport": "vp8channel" }
  ]
}
```

The saved order is `Second`, then `First`.

## Replacing a client's locations

`PUT /api/clients/{client_id}` with a non-empty `locations` array replaces the entire existing array. The request array becomes the new persisted order; locations are not appended or sorted by this handler.

```http
PUT /api/clients/alice
Content-Type: application/json

{
  "client_id": "alice",
  "locations": [
    { "name": "Room 2", "room_id": "room-2", "key": "...64 hex characters...", "carrier": "telemost", "transport": "vp8channel" },
    { "name": "Room 1", "room_id": "room-1", "key": "...64 hex characters...", "carrier": "telemost", "transport": "vp8channel" },
    { "name": "Room 3", "room_id": "room-3", "key": "...64 hex characters...", "carrier": "telemost", "transport": "vp8channel" }
  ]
}
```

After this request, the persisted order is `Room 2`, `Room 1`, `Room 3`.

If `locations` is omitted, the existing locations are kept. If a non-empty array is supplied, it is a complete replacement, not a partial patch. A replacement may therefore add, remove, or reorder locations.

## Adding one location

`POST /api/clients/{client_id}/locations` is different: it creates the supplied location and appends it to the end of the client's existing array.

Use the `PUT /api/clients/{client_id}` endpoint with the complete desired array when a location must be inserted at a particular position.

## Subscription order

A client subscription contains one URI entry for every location owned by that client. The entries are emitted in the client's persisted array order:

```text
olcrtc://telemost?...@room-2#key-2$Room 2

olcrtc://telemost?...@room-1#key-1$Room 1

olcrtc://telemost?...@room-3#key-3$Room 3
```

The subscription URL identifies the client, for example:

```text
/<subscription-path>/alice/
```

The subscription is generated when requested; locations are not pushed as separate subscriptions. All entries are returned in the one client subscription document.

If the client's quota is not active, the subscription still contains quota metadata but no location URI entries.

## Runtime startup order

The manager starts one `olcrtc` process per location. During a normal startup or reload, it traverses the configured location slice in order, so process startup follows the persisted order.

The order does not provide failover priority or preference. It only affects startup sequence and the order of URI lines in the subscription.

## Admin panel caveat

The admin state response sorts each client's locations alphabetically by `name` before returning them to the frontend. Therefore, the panel normally displays locations alphabetically, not in the persisted/API order.

When the panel edits one location, it builds a complete `locations` array from the displayed list and sends it through `PUT /api/clients/{client_id}`. As a result, saving an edit in the panel can persist alphabetical-by-name order.

The panel's separate **Add location** action uses `POST /api/clients/{client_id}/locations`, so a newly added location is appended to the persisted array. It may then appear in a different position in the panel because the next state response sorts by name.

## Summary

| Operation | Resulting order |
| --- | --- |
| `POST /api/clients` with `locations` | Request array order |
| `PUT /api/clients/{id}` with `locations` | Replaces all locations with request array order |
| `PUT /api/clients/{id}` without `locations` | Existing order preserved |
| `POST /api/clients/{id}/locations` | New location appended |
| Subscription generation | Persisted client location order |
| Runtime startup | Persisted configuration order |
| Admin panel display | Alphabetical by location name |
| Panel location edit | Can persist the panel's displayed alphabetical order |
