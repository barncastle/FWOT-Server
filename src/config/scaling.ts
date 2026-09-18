/**
 * The four scaling factors: a plain multiplier over one explicit field table
 * each. A factor of 1.0 skips its pass entirely, which keeps the served bytes
 * identical to a genuine build -- scaling is a HOST CHOICE, and the rule is that
 * the default is genuine and anything else is logged as not.
 */
import { asObject, numberOf, rawNumber, type Row } from "./json.js";

/**
 * A field the host's scaling factors may touch. The section qualifies it: the
 * same name means different things in different sections -- `amount` is a rent
 * payout in BuildingRent, a drop quantity in Drop and a premium-currency grant
 * for real money in IAPConfig, and `currencyAmount` is a reward in Reward but a
 * price in Price. Every entry below was checked against the season set.
 */
interface ScaledField {
  readonly section: string;
  readonly field: string;
  /** Row guard, where only some rows of a section qualify. */
  readonly when?: (row: Row) => boolean;
}

/** Waits on what the player builds, all whole seconds. */
const BUILD_TIME_FIELDS: ScaledField[] = [
  { section: "RentBuilding", field: "constructionTime" }, // building construction wait
  { section: "Skins", field: "buildTime" },               // skin unlock wait
  { section: "BuildingRent", field: "interval" },         // wait between rent collections
  { section: "Blocks", field: "unlockingTime" },          // land clearing wait
];

/** Waits on what the characters do, all whole seconds. */
const ACTION_TIME_FIELDS: ScaledField[] = [
  { section: "CraftingRecipe", field: "craftTime" },      // crafting wait
  { section: "SoloActions", field: "duration" },          // one-character job wait
  { section: "DualAction", field: "duration" },           // two-character job wait
];

// Rejected: Job has no duration (it is name/icon/colour metadata only), and
// SquatterAction.duration, *.idleTime, Goals.duration ("48h", a string) and the
// UI timings in FingerInfo/FUTips/PlayspaceDialogue are not build waits.

const CURRENCY_OR_MATERIAL_DROP = new Set(["Material", "Currency", "LootBox"]);

/** What the player is given. */
const REWARD_FIELDS: ScaledField[] = [
  { section: "Reward", field: "currencyAmount" },   // paired with currencyType
  { section: "Reward", field: "materialAmount" },   // paired with materialId
  { section: "Reward", field: "xp" },
  { section: "Reward", field: "eventXp" },
  { section: "BuildingRent", field: "amount" },     // rent payout
  { section: "BuildingRent", field: "xp" },
  { section: "Blocks", field: "xp" },
  { section: "RentBuilding", field: "constructionXp" },
  { section: "Goals", field: "reward-xp" },
  { section: "Level", field: "premiumCurrencyReward" }, // level-up payout
  // Drop.type is Material, Currency, LootBox or Decoration. A decoration drop
  // is a placeable grant, not a quantity.
  {
    section: "Drop",
    field: "amount",
    when: (r) => typeof r["type"] === "string" && CURRENCY_OR_MATERIAL_DROP.has(r["type"]),
  },
];

// Rejected: Reward.rawInventory[].amount -- it would qualify only where
// typeKey is a currency or a material, and no such row exists. Every typeKey in
// the season set is Character, Skin, RentBuilding, Head, Decoration or
// MovingDeco, none of which may be scaled. Level.xp is the threshold
// to REACH a level, not a payout. IAPConfig.amount is premium currency bought
// with real money.

/** What the player pays. */
const COST_FIELDS: ScaledField[] = [
  { section: "Price", field: "currencyAmount" },
  { section: "Price", field: "materialAmount" },
  { section: "Price", field: "materialBuyout" }, // premium buyout of the same materials
  { section: "Price", field: "fastFinishCost" },
  { section: "RentBuilding", field: "prices" },
  { section: "RentBuilding", field: "ownedPrices" },
  { section: "RentBuilding", field: "unlockCost" },
  { section: "RentBuilding", field: "fastFinishCost" },
  { section: "BuildingRent", field: "fastFinishCost" },
  { section: "Blocks", field: "currencyAmount" },  // land purchase
  { section: "Blocks", field: "fastFinishCost" },
  { section: "SquatterStreak", field: "fastFinishCost" },
  { section: "Objectives", field: "skipCost" },
  { section: "Character", field: "premiumPrice" }, // bribe cost
  { section: "Character", field: "currencyAmount" },
  { section: "Road", field: "premiumPrice" },
  { section: "Road", field: "prices" },
  { section: "Sidewalk", field: "premiumPrice" },
  { section: "Sidewalk", field: "prices" },
  { section: "Material", field: "buyPrice" },
  { section: "MovingDecoInfo", field: "currencyAmount" },
  { section: "MysteryBox", field: "currencyAmount" },
  { section: "GenericShopOffer", field: "prices" },
  { section: "MaterialShopOffer", field: "prices" },
];

// Rejected: IAPConfig.price_usd is real money, never scaled.

/**
 * Scale one value. Only a positive number moves: zero stays zero, and a
 * negative is a sentinel ("no cost", "never"), not a quantity. An integer stays
 * an integer and never rounds down to nothing; a float keeps its literal form.
 */
function scaleValue(value: unknown, factor: number): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const scaled = scaleValue(item, factor);
      if (scaled !== undefined) { changed = true; return scaled; }
      return item;
    });
    return changed ? out : undefined;
  }
  const n = numberOf(value);
  if (n === null || n <= 0) return undefined;
  if (Number.isInteger(n) && typeof value === "number") {
    return Math.max(1, Math.round(n * factor));
  }
  const text = String(n * factor);
  return rawNumber(/[.eE]/.test(text) ? text : `${text}.0`);
}

/** Copy-on-write: the same reference back when nothing in the table moved. */
function scaleDoc(doc: unknown, sections: Map<string, ScaledField[]>, factor: number): unknown {
  const root = asObject(doc);
  if (!root) return doc;
  let out: Row | null = null;
  for (const [name, ops] of sections) {
    const section = root[name];
    if (section === undefined || section === null || typeof section !== "object") continue;
    const entries: [string | number, unknown][] = Array.isArray(section)
      ? section.map((r, i) => [i, r])
      : Object.entries(section as Row);
    let scaled: Row | unknown[] | null = null;
    for (const [key, value] of entries) {
      const row = asObject(value);
      if (!row) continue;
      let next: Row | null = null;
      for (const op of ops) {
        if (!(op.field in row)) continue;
        if (op.when && !op.when(row)) continue;
        const scaledValue = scaleValue(row[op.field], factor);
        if (scaledValue === undefined) continue;
        next ??= { ...row };
        next[op.field] = scaledValue;
      }
      if (next) {
        scaled ??= Array.isArray(section) ? [...section] : { ...section as Row };
        (scaled as Row)[key] = next;
      }
    }
    if (scaled) {
      out ??= { ...root };
      out[name] = scaled;
    }
  }
  return out ?? doc;
}

function bySection(fields: ScaledField[]): Map<string, ScaledField[]> {
  const out = new Map<string, ScaledField[]>();
  for (const field of fields) {
    const list = out.get(field.section) ?? [];
    list.push(field);
    out.set(field.section, list);
  }
  return out;
}

export interface ScalingFactors {
  buildTime: number;
  actionTime: number;
  reward: number;
  cost: number;
}

/** The factors a host actually changed, and the passes they imply. */
export class Scaling {
  private readonly passes: [Map<string, ScaledField[]>, number][] = [];

  constructor(factors: ScalingFactors) {
    for (const [fields, factor] of [
      [BUILD_TIME_FIELDS, factors.buildTime],
      [ACTION_TIME_FIELDS, factors.actionTime],
      [REWARD_FIELDS, factors.reward],
      [COST_FIELDS, factors.cost],
    ] as [ScaledField[], number][]) {
      if (factor !== 1) this.passes.push([bySection(fields), factor]);
    }
  }

  get active(): boolean {
    return this.passes.length > 0;
  }

  /** Whether any table section could be in this file, without parsing it. */
  touches(text: string): boolean {
    return this.passes.some(([sections]) =>
      [...sections.keys()].some((name) => text.includes(`"${name}"`)));
  }

  /** The document with every active factor applied, or the same reference. */
  apply(doc: unknown): unknown {
    let out = doc;
    for (const [sections, factor] of this.passes) out = scaleDoc(out, sections, factor);
    return out;
  }
}
