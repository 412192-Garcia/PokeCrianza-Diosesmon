// Cota inferior fuerte para la búsqueda, por programación dinámica.
//
// Calcula, para cada estado (genes requeridos, naturaleza, género, familia), el
// costo mínimo de conseguirlo RESPETANDO especie, género y grupos huevo, pero
// permitiendo reutilizar Pokémon del PC (relajación). Como relaja solo el
// consumo, nunca sobreestima: es una cota admisible, y mucho más ajustada que
// una que ignore especies (que es lo que hacía explotar la búsqueda en PCs reales).
import { popcount } from "./model.js";

export const INF = 10 ** 9;
const GENDERS = ["F", "M", "N"];  // N = sin género
const GI = { F: 0, M: 1, N: 2 };

/** Todos los sub-conjuntos de `mask`, de mayor a menor (incluye 0). */
export function submasks(mask) {
  const out = [];
  let sub = mask;
  for (;;) {
    out.push(sub);
    if (sub === 0) return out;
    sub = (sub - 1) & mask;
  }
}

export class CotaDP {
  constructor(dex, inv, targetMask, nature, allowDitto, leafCost, splits, breedCost = 1) {
    this.dex = dex;
    this.breedCost = breedCost;
    this.frozen = false;
    this.memo = new Map();   // solo cuando la tabla ya no cambia
    this.natures = nature ? [false, true] : [false];
    const breeders = inv.filter(p => !dex.isDitto(p.species));
    this.families = [...new Set(breeders.map(p => dex.family(p.species)))].sort();
    this.famIdx = new Map(this.families.map((f, i) => [f, i]));
    this.nF = this.families.length;
    this.v = new Map();       // clave numérica (mask, nat, género, familia) -> costo
    this.ditto = new Map();   // (mask, nat) -> costo

    // compat[F] = familias G cuyo macho puede cruzar con una madre de familia F.
    // Se une la compatibilidad por especie concreta de las hojas (cota admisible).
    this.compat = new Map();
    for (const f of this.families) {
      const ok = new Set(this.families.filter(g => dex.compatible(g, f)));
      for (const p of breeders) if (dex.compatible(p.species, f)) ok.add(dex.family(p.species));
      this.compat.set(f, [...ok].sort());
    }
    this.compatIdx = this.families.map(f => this.compat.get(f).map(g => this.famIdx.get(g)));

    // Hojas: cada Pokémon cubre todos los sub-conjuntos de sus genes.
    for (const p of inv) {
      const hasNat = nature !== null && p.nature === nature;
      const cost = leafCost(p);
      const esDitto = dex.isDitto(p.species);
      const fi = esDitto ? -1 : this.famIdx.get(dex.family(p.species));
      for (const sub of submasks(p.mask & targetMask)) {
        for (const nat of this.natures) {
          if (nat && !hasNat) continue;
          if (esDitto) {
            const k = this.kd(sub, nat);
            if (cost < this.getD(k)) this.ditto.set(k, cost);
          } else {
            const k = this.kv(sub, nat, GI[p.gender ?? "N"], fi);
            if (cost < this.getV(k)) this.v.set(k, cost);
          }
        }
      }
    }

    const masks = submasks(targetMask).sort((a, b) => popcount(a) - popcount(b));
    for (const mask of masks) {
      for (const nat of this.natures) {
        // Varias pasadas: los cruces "conversores" dependen de la misma máscara.
        for (let i = 0; i < 4; i++) if (!this.relax(mask, nat, splits, allowDitto)) break;
      }
    }
    this.frozen = true;
  }

  kv(mask, nat, gi, fi) { return ((mask * 2 + (nat ? 1 : 0)) * 3 + gi) * this.nF + fi; }
  kd(mask, nat) { return mask * 2 + (nat ? 1 : 0); }
  getV(k) { return this.v.get(k) ?? INF; }
  getD(k) { return this.ditto.get(k) ?? INF; }
  /** Costo de cumplir el género `gi` (F o M): un sin género cumple cualquiera. */
  conGenero(mask, nat, gi, fi) {
    return Math.min(this.getV(this.kv(mask, nat, gi, fi)), this.getV(this.kv(mask, nat, GI.N, fi)));
  }

  childGenders(fam, normal) {
    const pol = this.dex.genderPolicy(fam);
    if (pol === null) return ["F", "M"];
    if (normal && pol === "M") return [];  // solo machos: solo puede venir de un cruce con Ditto
    return [pol];
  }

  anyGender(mask, nat, fi) {
    return Math.min(this.getV(this.kv(mask, nat, 0, fi)), this.getV(this.kv(mask, nat, 1, fi)),
      this.getV(this.kv(mask, nat, 2, fi)));
  }

  compatCost(mask, nat, gender, fi) {
    const key = (this.kv(mask, nat, 0, fi) * 4) + (gender === null ? 3 : GI[gender]);
    if (this.frozen) {
      const m = this.memo.get(key);
      if (m !== undefined) return m;
    }
    let r = INF;
    for (const h of this.compatIdx[fi]) {
      if (gender === null) r = Math.min(r, this.anyGender(mask, nat, h));
      else r = Math.min(r, this.conGenero(mask, nat, GI[gender], h));
    }
    if (this.frozen) this.memo.set(key, r);
    return r;
  }

  relax(mask, nat, splits, allowDitto) {
    let changed = false;
    for (const [specA, specB] of splits(mask, nat)) {
      for (const [[m1, , n1], [m2, , n2]] of [[specA, specB], [specB, specA]]) {
        for (let fi = 0; fi < this.nF; fi++) {
          const fam = this.families[fi];
          const mother = this.conGenero(m1, n1, GI.F, fi);
          if (mother < INF) {
            const c = this.breedCost + mother + this.compatCost(m2, n2, "M", fi);
            for (const g of this.childGenders(fam, true)) {
              const k = this.kv(mask, nat, GI[g], fi);
              if (c < this.getV(k)) { this.v.set(k, c); changed = true; }
            }
          }
          if (allowDitto) {
            const d = this.getD(this.kd(m2, n2));
            if (d < INF) {
              const c = this.breedCost + this.anyGender(m1, n1, fi) + d;
              for (const g of this.childGenders(fam, false)) {
                const k = this.kv(mask, nat, GI[g], fi);
                if (c < this.getV(k)) { this.v.set(k, c); changed = true; }
              }
            }
          }
        }
      }
    }
    return changed;
  }

  /** Costo mínimo relajado de un sub-objetivo del planificador. cons: null o [tipo, familia]. */
  bound(mask, nat, gender, cons, ditto) {
    if (ditto) return this.getD(this.kd(mask, nat));
    if (cons === null) {
      let r = INF;
      for (let fi = 0; fi < this.nF; fi++) r = Math.min(r, this.anyGender(mask, nat, fi));
      return r;
    }
    const fi = this.famIdx.get(cons[1]);
    if (fi === undefined) return INF;
    if (cons[0] === "exact") {
      return gender === null ? this.anyGender(mask, nat, fi) : this.conGenero(mask, nat, GI[gender], fi);
    }
    return this.compatCost(mask, nat, gender, fi);
  }
}
