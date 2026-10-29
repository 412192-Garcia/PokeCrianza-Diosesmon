// Base de datos de especies: grupos huevo, género y línea evolutiva.
// Usa el pokedex.json de Pokémon Showdown (mismos grupos huevo que PokeMMO y Cobblemon).

export const UNDISCOVERED = "Undiscovered";
export const DITTO_GROUP = "Ditto";

const ids = new Map();
export function toId(name) {
  let id = ids.get(name);
  if (id === undefined) {
    id = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    ids.set(name, id);
  }
  return id;
}

export class Dex {
  constructor(entries) {
    this.byId = entries;
    this._grupos = new Map();
    this._familia = new Map();
    this._compat = new Map();
  }

  // --- consultas básicas -------------------------------------------------
  entry(name) {
    return this.byId[toId(name)] ?? null;
  }

  canonical(name) {
    const e = this.entry(name);
    return e ? e.name.replace(/’/g, "'") : null;
  }

  /** True si el nombre (con guion incluido) es una especie base, no una forma. */
  isBaseName(name) {
    const e = this.entry(name);
    return !!e && !e.baseSpecies && !e.forme;
  }

  eggGroups(species) {
    let g = this._grupos.get(species);
    if (!g) {
      g = this.entry(species).eggGroups;
      this._grupos.set(species, g);
    }
    return g;
  }

  isDitto(species) { return this.eggGroups(species).includes(DITTO_GROUP); }
  canBreed(species) { return !this.eggGroups(species).includes(UNDISCOVERED); }

  /** 'M' / 'F' si es mono-género, 'N' si no tiene género, null si ambos. */
  genderPolicy(species) { return this.entry(species).gender ?? null; }

  // --- reglas de crianza ---------------------------------------------------
  /**
   * Especie EXACTA que sale del huevo si `species` es la madre.
   * Baja por la pre-evolución, pero se detiene antes de un bebé del grupo
   * Undiscovered (Pichu, Happiny...) porque un bebé no puede criar y el
   * árbol necesita que la cría sea reutilizable como padre.
   */
  family(species) {
    let f = this._familia.get(species);
    if (f === undefined) {
      let cur = this.entry(species);
      while (cur.prevo) {
        const prev = this.entry(cur.prevo);
        if (!prev || prev.eggGroups.includes(UNDISCOVERED)) break;
        cur = prev;
      }
      f = cur.name;
      this._familia.set(species, f);
    }
    return f;
  }

  /** Dos especies NO-Ditto comparten al menos un grupo huevo (de ESAS especies). */
  compatible(a, b) {
    const k = a + "\u0000" + b;
    let r = this._compat.get(k);
    if (r === undefined) {
      const ga = this.eggGroups(a), gb = this.eggGroups(b);
      const malo = g => g.includes(UNDISCOVERED) || g.includes(DITTO_GROUP);
      r = !malo(ga) && !malo(gb) && ga.some(x => gb.includes(x));
      this._compat.set(k, r);
    }
    return r;
  }
}
