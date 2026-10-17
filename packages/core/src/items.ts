// The Broker's shelf. List prices stay small so a full demo run fits under the
// default 3 USD spend cap (list price plus every haggling fee).

export interface Item {
  id: string;
  name: string;
  blurb: string;
  /** List price in atomic USDC. */
  listPrice: number;
  /** Lowest floor the Broker may draw, as a fraction of list. */
  floorMin: number;
  /** Highest floor the Broker may draw, as a fraction of list. */
  floorMax: number;
  /** Art key for the UI. */
  art: "compass" | "robot" | "phone" | "camera";
}

export const ITEMS: readonly Item[] = [
  {
    id: "brass-compass",
    name: "Brass Pocket Compass",
    blurb: "Points north most of the time. Lid engraved with somebody else's initials.",
    listPrice: 1_800_000,
    floorMin: 0.68,
    floorMax: 0.88,
    art: "compass",
  },
  {
    id: "tin-robot",
    name: "Tin Robot No. 7",
    blurb: "Wind-up key included. Walks in a confident circle. Slight rust on the left ear.",
    listPrice: 2_400_000,
    floorMin: 0.66,
    floorMax: 0.86,
    art: "robot",
  },
  {
    id: "rotary-phone",
    name: "Orange Rotary Phone",
    blurb: "Dial tone not guaranteed. Rings loud enough to wake the night shift.",
    listPrice: 1_500_000,
    floorMin: 0.7,
    floorMax: 0.9,
    art: "phone",
  },
  {
    id: "box-camera",
    name: "Folding Box Camera",
    blurb: "Leather bellows, one roll of mystery film still inside. No refunds on the film.",
    listPrice: 2_000_000,
    floorMin: 0.65,
    floorMax: 0.85,
    art: "camera",
  },
] as const;

export function findItem(id: string): Item | undefined {
  return ITEMS.find((item) => item.id === id);
}
