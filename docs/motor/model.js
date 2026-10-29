// Tipos base: IVs como bitmask de "genes", Pokémon del PC y nodos del árbol.
//
// Cada gen es un (stat, valor): los bits 0-5 son "stat en 31" y los bits 6-11
// son "stat en 0". Las reglas de herencia son idénticas para ambos: un Objeto
// Recio fuerza el valor que tenga ese padre, y si ambos padres comparten el
// mismo valor en un stat, se hereda gratis.

export const STATS = ["HP", "Atk", "Def", "SpA", "SpD", "Spe"];
export const STAT_INDEX = Object.fromEntries(STATS.map((s, i) => [s.toLowerCase(), i]));
export const ZERO_SHIFT = 6;
export const MASK31 = (1 << 6) - 1;
export const MASK0 = MASK31 << ZERO_SHIFT;
export const EVERSTONE = "EVERSTONE";

export function popcount(mask) {
  let c = 0;
  while (mask) { mask &= mask - 1; c++; }
  return c;
}

/** Genes presentes (0-5 = stat en 31, 6-11 = stat en 0). */
export function bits(mask) {
  const out = [];
  for (let g = 0; g < 12; g++) if (mask >> g & 1) out.push(g);
  return out;
}

export const ivs31 = mask => [0, 1, 2, 3, 4, 5].filter(i => mask >> i & 1);
export const ivs0 = mask => [0, 1, 2, 3, 4, 5].filter(i => mask >> (ZERO_SHIFT + i) & 1);
export const geneStat = g => g % 6;
export const geneValue = g => (g < ZERO_SHIFT ? 31 : 0);

/**
 * Un Pokémon real del PC (recurso consumible).
 * uid: posición en el archivo (1-based); mask: genes; ivs: los 6 IVs tal cual (o null).
 */
export function pokemon(uid, species, gender, nature, mask, line, level = null, ivs = []) {
  return Object.freeze({ uid, species, gender, nature, mask, line, level, ivs });
}

/** Hoja del árbol: un Pokémon del PC usado tal cual. */
export class Leaf {
  constructor(mon, natured = false, cost = 0) {
    this.mon = mon;
    this.natured = natured;   // tiene la naturaleza objetivo
    this.cost = cost;
  }
  get species() { return this.mon.species; }
  get gender() { return this.mon.gender; }
  get mask() { return this.mon.mask; }
}

/** Nodo interno: cruce de dos padres que se consumen. */
export class Breed {
  constructor(f) {
    this.species = f.species;       // especie EXACTA que nace (familia de la madre / no-Ditto)
    this.gender = f.gender;         // género que hay que elegir/obtener para la cría
    this.mask = f.mask;             // genes garantizados de la cría
    this.natured = f.natured;
    this.p1 = f.p1;                 // madre (o padre no-Ditto si se cruza con Ditto)
    this.p2 = f.p2;                 // padre (o Ditto)
    this.item1 = f.item1;           // stat del Objeto Recio (número), EVERSTONE o null
    this.item2 = f.item2;
    this.withDitto = f.withDitto;
    this.cost = f.cost ?? 0;
    this.step = f.step ?? 0;        // nº de paso, asignado al armar la respuesta (post-orden)
    this.req = f.req ?? null;       // el sub-objetivo que resuelve, para poder mejorarlo después
  }
  /** Copia con algunos campos cambiados. */
  with(cambios) { return new Breed({ ...this, ...cambios }); }
}
