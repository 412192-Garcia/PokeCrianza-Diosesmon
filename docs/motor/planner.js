// Búsqueda del árbol de crianza con recursos consumibles.
//
// Algoritmo: profundización iterativa sobre el COSTO + backtracking con
// generadores + cota inferior admisible.
//
// * Regla de este server: un Pokémon sin género cumple el género que falta. Con
//   un macho hace de madre (nace su especie), con una hembra hace de padre (nace
//   la de ella), y si los dos son sin género se elige quién hace de cada uno.
// * Cada sub-objetivo es un `Req`: "necesito un Pokémon con estos genes, este
//   género, cuya especie cumpla esta restricción (y quizá la naturaleza)".
// * `gen(req, budget)` es un generador que va PRODUCIENDO planes válidos que
//   cuestan <= budget. Mientras un plan está "en vuelo" (entre su `yield` y la
//   reanudación del generador), los Pokémon del PC que usa están marcados en
//   `used`; al reanudarse (backtrack) o cortarse el generador se liberan. Así una
//   rama nunca puede reutilizar a un padre que otra rama del mismo árbol ya consumió.
// * COSTO de un árbol = peso del cruce × nº de cruces + valor de cada Pokémon del
//   PC que se consume, donde uno con k IVs útiles vale 2^(k-1) (lo que cuesta
//   criarlo desde 1x31) y uno sin IVs útiles no vale nada.
// * Se empieza en una cota inferior calculada por programación dinámica (ver
//   cotas.js): el primer árbol que aparece es el más barato posible con tu PC.
import { CotaDP, INF } from "./cotas.js";
import { Breed, EVERSTONE, Leaf, MASK0, MASK31, bits, popcount } from "./model.js";

export class SearchLimit extends Error {}
/** Un intento con un presupuesto dado agotó su cuota de nodos sin concluir. */
class AttemptLimit extends Error {}

/**
 * Sub-objetivo. cons: restricción de especie, propagada por la línea materna:
 *   ["exact", F]  -> la familia (lo que nace) debe ser exactamente F
 *   ["compat", F] -> la especie debe compartir grupo huevo con la familia F
 */
export class Req {
  constructor(mask, gender, cons, natured = false, ditto = false) {
    this.mask = mask;          // genes (31 o 0) que necesitamos garantizados
    this.gender = gender;      // "M", "F" o null (da igual)
    this.cons = cons;
    this.natured = natured;    // debe tener la naturaleza objetivo
    this.ditto = ditto;        // el hueco es para un Ditto
    this.key = `${mask}|${gender ?? "-"}|${cons ? cons[0][0] + cons[1] : "-"}|${natured ? 1 : 0}|${ditto ? 1 : 0}`;
  }
}

/**
 * Formas de repartir `mask` entre dos padres A y B.
 * Devuelve pares [[maskA, itemA, natA], [maskB, itemB, natB]].
 * Regla de superposición: cría = (A ∩ B) ∪ {objeto de A} ∪ {objeto de B}.
 */
export function* splits(mask, natured) {
  const k = popcount(mask);
  const stats = bits(mask);
  if (natured) {
    // Uno lleva Piedra Eterna (necesita la naturaleza, aporta solo solape);
    // el otro lleva el único Objeto Recio libre.
    if (k === 0) return;
    for (const b of stats) yield [[mask & ~(1 << b), EVERSTONE, true], [mask, b, false]];
    return;
  }
  if (k === 0) {
    // Cría que no pasa IVs: solo sirve con Ditto, para cambiar el género
    // (ej. el único Togetic es macho: Togetic + Ditto -> Togetic hembra).
    yield [[0, null, false], [0, null, false]];
    return;
  }
  if (k === 1) {
    // Cría "conversora": cambia especie/género conservando un 31.
    yield [[mask, stats[0], false], [0, null, false]];
    return;
  }
  for (const a of stats) {
    for (const b of stats) {
      // A tiene todo menos b y fuerza a; B tiene todo menos a y fuerza b.
      if (a < b) yield [[mask & ~(1 << b), a, false], [mask & ~(1 << a), b, false]];
    }
  }
}

const mismoSplit = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/** Conjunto de Pokémon usados como vector de bits (índice dentro del inventario). */
class Usados {
  constructor(n) {
    this.w = new Uint32Array((n >> 5) + 1);
    this.size = 0;
  }
  has(i) { return (this.w[i >> 5] >>> (i & 31) & 1) === 1; }
  add(i) { if (!this.has(i)) { this.w[i >> 5] |= 1 << (i & 31); this.size++; } }
  delete(i) { if (this.has(i)) { this.w[i >> 5] &= ~(1 << (i & 31)); this.size--; } }
  clear() { this.w.fill(0); this.size = 0; }
  snapshot() { return this.w.slice(); }
}
/** a ⊆ b, para dos snapshots. */
function subconjunto(a, b) {
  for (let i = 0; i < a.length; i++) if ((a[i] & ~b[i]) !== 0) return false;
  return true;
}

export class Planner {
  constructor(dex, inventory, targetSpecies, {
    nature = null, allowDitto = true, maxNodes = 3_000_000, timeLimit = 20, improveTime = 10, pesoCruce = 1,
  } = {}) {
    this.dex = dex;
    // Inventario ordenado: primero los que tienen MENOS genes (no gastar los buenos).
    this.inv = inventory.filter(p => dex.canBreed(p.species))
      .sort((a, b) => popcount(a.mask) - popcount(b.mask) || a.uid - b.uid);
    this.idx = new Map(this.inv.map((p, i) => [p.uid, i]));
    this.targetFamily = dex.family(targetSpecies);
    this.nature = nature ? nature.charAt(0).toUpperCase() + nature.slice(1).toLowerCase() : null;
    this.allowDitto = allowDitto && this.inv.some(p => dex.isDitto(p.species));
    this.maxNodes = maxNodes;
    this.timeLimit = timeLimit;      // segundos
    this.improveTime = improveTime;  // segundos extra para la mejora por ramas
    // Cuánto "vale" un cruce frente a gastar Pokémon (un 1x31 vale 1, un 2x31 2, un 3x31 4...).
    // 1 = cuidar los Pokémon; más alto = menos cruces aunque se gasten Pokémon mejores.
    this.pesoCruce = Math.max(1, pesoCruce);
    this.altCap = 0;                 // >0: pasada rápida que prueba pocas alternativas (no exacta)
    this.deadline = Infinity;        // ms (performance.now)
    this.attemptLimit = Infinity;
    this.dpCost = null;              // cota fuerte en costo ponderado
    this.dpBreeds = null;            // cota fuerte en nº de cruces
    this.used = new Usados(this.inv.length);
    this.valueMask = MASK31;         // genes que dan valor a un Pokémon (los 31 + los 0 que pide el objetivo)
    this.nogoods = new Map();        // req.key -> [[presupuesto, snapshot de usados], ...]
    this.nodes = 0;
    this.weighted = false;           // false: solo cuenta cruces; true: costo ponderado
    this.optimal = true;             // false si se cortó por tiempo antes de demostrar que es la más barata
    this.lbCache = new Map();
  }

  // --- utilidades -----------------------------------------------------------
  hasNature(p) { return this.nature !== null && p.nature === this.nature; }

  satisfies(species, cons) {
    if (cons === null) return true;
    if (cons[0] === "exact") return this.dex.family(species) === cons[1];
    // FIX doble grupo huevo: se comparan los grupos de ESTA especie concreta
    // con los de la familia materna concreta, nunca con un comodín "ANY".
    return this.dex.compatible(species, cons[1]);
  }

  genderPossible(family, gender) {
    if (gender === null) return true;
    const pol = this.dex.genderPolicy(family);
    return pol === null || pol === gender || pol === "N";  // el sin género cumple cualquiera
  }

  /** Costo de un cruce: su peso al buscar la más barata, 1 al contar cruces. */
  cruce(weighted = this.weighted) { return weighted ? this.pesoCruce : 1; }

  /**
   * Valor de consumir `p`: 2^(k-1) para k IVs útiles (0 si solo contamos cruces).
   * Uno sin IVs útiles no vale nada: así, donde solo hace falta un padre que
   * pase la especie o el género, se gasta ese y no uno con un 31.
   */
  leafCost(p, weighted = this.weighted) {
    if (!weighted) return 0;
    const k = popcount(p.mask & this.valueMask);
    return k ? 1 << (k - 1) : 0;
  }

  /** Cota inferior relajada (ignora especie, género y consumo) -> admisible. */
  lowerBound(mask, natured, weighted) {
    const key = mask * 4 + (natured ? 2 : 0) + (weighted ? 1 : 0);
    const c = this.lbCache.get(key);
    if (c !== undefined) return c;
    let best = INF;
    for (const p of this.inv) {
      if ((p.mask & mask) === mask && (!natured || this.hasNature(p))) best = Math.min(best, this.leafCost(p, weighted));
    }
    if (!(popcount(mask) <= 1 && !natured)) {  // convertir nunca crea un 31 nuevo ni abarata
      for (const [[ma, , na], [mb, , nb]] of splits(mask, natured)) {
        best = Math.min(best, this.cruce(weighted) + this.lowerBound(ma, na, weighted) + this.lowerBound(mb, nb, weighted));
      }
    }
    this.lbCache.set(key, best);
    return best;
  }

  lb(mask, natured) { return this.lowerBound(mask, natured, this.weighted); }

  bound(req) {
    const dp = this.weighted ? this.dpCost : this.dpBreeds;
    return dp.bound(req.mask, req.natured, req.gender, req.cons, req.ditto);
  }

  boundBreeds(req) {
    return this.dpBreeds.bound(req.mask, req.natured, req.gender, req.cons, req.ditto);
  }

  // --- búsqueda -------------------------------------------------------------
  *leaves(req, budget) {
    const seen = new Set();
    for (let i = 0; i < this.inv.length; i++) {
      const p = this.inv[i];
      if (this.used.has(i) || (p.mask & req.mask) !== req.mask) continue;
      if (this.leafCost(p) > budget) continue;
      if (req.natured && !this.hasNature(p)) continue;
      if (req.ditto) {
        if (!this.dex.isDitto(p.species)) continue;
      } else {
        if (this.dex.isDitto(p.species)) continue;
        // Un sin género (acá ya no es un Ditto) cumple el género que falte.
        if (req.gender !== null && p.gender !== null && p.gender !== req.gender) continue;
        if (!this.satisfies(p.species, req.cons)) continue;
      }
      // Individuos equivalentes son intercambiables: probar solo uno por clase.
      // Un padre que solo tiene que ser compatible vale por sus grupos huevo,
      // no por su especie (así sobran los cientos de Pokémon de relleno).
      const quien = req.cons && req.cons[0] === "compat" ? this.dex.eggGroups(p.species).join(",") : p.species;
      const key = `${quien}|${p.gender}|${p.mask & this.valueMask}|${this.hasNature(p)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      this.used.add(i);
      try {
        yield new Leaf(p, this.hasNature(p), this.leafCost(p));
      } finally {
        this.used.delete(i);
      }
    }
  }

  /**
   * Envuelve la búsqueda con una caché de 'nogoods': si `req` no tuvo solución
   * con presupuesto b y el conjunto usado U, tampoco la tendrá con b' <= b y
   * U' ⊇ U (menos presupuesto y menos Pokémon libres).
   */
  *gen(req, budget) {
    this.nodes++;
    if (this.nodes > this.maxNodes || ((this.nodes & 511) === 0 && performance.now() > this.deadline)) {
      throw new SearchLimit();
    }
    if (this.nodes > this.attemptLimit) throw new AttemptLimit();
    // Un subárbol de c cruces consume c+1 Pokémon: no puede pasar de los libres.
    if (this.boundBreeds(req) + 1 > this.inv.length - this.used.size) return;
    if (budget < 0 || this.bound(req) > budget) return;
    const snapshot = this.used.snapshot();
    let fails = this.nogoods.get(req.key);
    if (!fails) { fails = []; this.nogoods.set(req.key, fails); }
    for (const [b, used] of fails) {
      if (budget <= b && subconjunto(used, snapshot)) return;
    }
    let found = false;
    for (const plan of this.expand(req, budget)) {
      found = true;
      yield plan;
    }
    if (!found) fails.push([budget, snapshot]);
  }

  *expand(req, budget) {
    yield* this.leaves(req, budget);
    const cruce = this.cruce();
    if (budget < cruce || req.ditto) return;
    const free = this.inv.length - this.used.size;

    // Se arman todas las opciones y se prueban de la más prometedora a la menos
    // (según la cota): así el primer árbol encontrado ya suele ser muy barato.
    const options = [];
    for (const [specA, specB] of splits(req.mask, req.natured)) {
      const ordenes = mismoSplit(specA, specB) ? [[specA, specB]] : [[specA, specB], [specB, specA]];
      for (const [[m1, i1, n1], [m2, i2, n2]] of ordenes) {
        if (cruce + this.lb(m1, n1) + this.lb(m2, n2) > budget) continue;
        if (this.lowerBound(m1, n1, false) + this.lowerBound(m2, n2, false) + 2 > free) continue;
        for (const withDitto of this.allowDitto ? [false, true] : [false]) {
          if (!req.mask && !withDitto) continue;  // sin genes ni Ditto, la cría sería igual a la madre
          // p1 = madre (o el no-Ditto): DEFINE la especie de la cría,
          // así que hereda la misma restricción que la cría.
          const r1 = new Req(m1, withDitto ? null : "F", req.cons, n1);
          const lb2 = withDitto ? this.bound(new Req(m2, null, null, n2, true)) : this.lb(m2, n2);
          const est = cruce + this.bound(r1) + lb2;
          if (est <= budget) options.push({ est, orden: options.length, r1, lb2, m2, n2, i1, i2, withDitto });
        }
      }
    }
    options.sort((a, b) => a.est - b.est || a.orden - b.orden);

    for (const { r1, lb2, m2, n2, i1, i2, withDitto } of options) {
      for (const p1 of this.capped(this.gen(r1, budget - cruce - lb2))) {
        const fam = this.dex.family(p1.species);
        if (!this.genderPossible(fam, req.gender)) continue;
        // El padre se valida contra los grupos huevo de la especie EXACTA que
        // aportó la madre en este nodo.
        const r2 = withDitto ? new Req(m2, null, null, n2, true) : new Req(m2, "M", ["compat", fam], n2);
        if (cruce + p1.cost + this.bound(r2) > budget) continue;
        for (const p2 of this.capped(this.gen(r2, budget - cruce - p1.cost))) {
          // Superposición: lo que ambos tienen se hereda gratis.
          let childMask = p1.mask & p2.mask;
          for (const it of [i1, i2]) if (typeof it === "number") childMask |= 1 << it;
          yield new Breed({
            species: fam, gender: this.dex.genderPolicy(fam) === "N" ? null : req.gender, mask: childMask, natured: req.natured, p1, p2,
            item1: i1, item2: i2, withDitto, cost: cruce + p1.cost + p2.cost, req,
          });
        }
      }
    }
  }

  /** En la pasada rápida, corta tras `altCap` alternativas por sub-objetivo. */
  *capped(it) {
    if (this.altCap <= 0) { yield* it; return; }
    let n = 0;
    for (const node of it) {
      if (n >= this.altCap) return;  // salir del for-of cierra el generador
      n++;
      yield node;
    }
  }

  /** Primer plan de `gen(req, budget)` o null; si se acaba la cuota, lanza AttemptLimit. */
  primero(req, budget, quota) {
    this.attemptLimit = this.nodes + quota;
    const g = this.gen(req, budget);
    try {
      const r = g.next();
      return r.done ? null : r.value;
    } finally {
      g.return();  // congela el plan: sus Pokémon ya están en el árbol
      this.attemptLimit = Infinity;
    }
  }

  /** ¿Hay un árbol de costo <= budget? -> ["si", plan] / ["no", null] / ["?", null]. */
  attempt(root, budget, quota) {
    this.used.clear();
    try {
      const plan = this.primero(root, budget, quota);
      return plan ? ["si", plan] : ["no", null];
    } catch (e) {
      if (e instanceof AttemptLimit) return ["?", null];
      throw e;
    }
  }

  /** Calcula las cotas para este objetivo (una sola vez) y devuelve su sub-objetivo raíz. */
  preparar(mask) {
    const root = new Req(mask, null, ["exact", this.targetFamily], this.nature !== null);
    if (this.preparado === mask) return root;
    this.preparado = mask;
    this.valueMask = MASK31 | (mask & MASK0);
    this.lbCache.clear();
    this.dpBreeds = new CotaDP(this.dex, this.inv, mask, this.nature, this.allowDitto,
      p => this.leafCost(p, false), splits);
    this.dpCost = new CotaDP(this.dex, this.inv, mask, this.nature, this.allowDitto,
      p => this.leafCost(p, true), splits, this.pesoCruce);
    this.weighted = true;
    return root;
  }

  /** Lo mínimo que puede costar este objetivo (INF si es imposible). */
  cota(mask) { return this.bound(this.preparar(mask)); }

  /**
   * Devuelve la ruta más barata (o null si no hay).
   * Si `optimal` queda en false, se acabó el tiempo antes de demostrar que no
   * existe una más barata: la ruta es válida pero puede mejorarse.
   * Con `tope`, solo interesa una ruta de costo menor a ese: si no hay, devuelve null.
   */
  solve(mask, tope = Infinity) {
    const root = this.preparar(mask);
    this.deadline = performance.now() + this.timeLimit * 1000;
    const budget = this.bound(root);
    if (budget >= INF) return null;  // ni reutilizando Pokémon se puede: imposible seguro
    // Gastar TODO el PC es el peor caso posible: cota superior del costo.
    const upper = Math.min(tope - 1,
      this.inv.reduce((t, p) => t + this.leafCost(p), 0) + this.inv.length * this.pesoCruce);

    let best = null;
    try {
      // Pasada 1 (rápida, no exacta): pocas alternativas por paso. Da una
      // buena ruta en poco tiempo, que sirve de tope para la pasada exacta.
      this.altCap = 6;
      for (let b = budget; b <= upper; b++) {
        const [status, plan] = this.attempt(root, b, 200_000);
        if (status === "si") { best = plan; break; }
      }
      // Pasada 2 (exacta): ¿hay algo más barato? Sube desde la cota; lo
      // primero que entra es la ruta más barata posible con tu PC.
      this.altCap = 0;
      this.nogoods = new Map();
      const stop = best ? best.cost - 1 : upper;
      for (let b = budget; b <= stop; b++) {
        const [status, plan] = this.attempt(root, b, Infinity);
        if (status === "si") { best = plan; break; }
      }
    } catch (e) {
      if (!(e instanceof SearchLimit)) throw e;
      this.optimal = false;
      if (best === null) throw e;
      best = this.improve(best, this.improveTime);
    }
    return best;
  }

  // --- mejora por ramas -------------------------------------------------------
  /**
   * Si la búsqueda se cortó por tiempo, mejora la ruta rama por rama.
   * Cada cruce resuelve un sub-objetivo (`Breed.req`, ej. "un macho con Def y
   * Spe compatible con Togetic"). Con el resto del árbol fijo, ese sub-objetivo
   * es un problema chico: se busca exacto si se puede armar más barato con los
   * Pokémon que el resto no usa. Se repite hasta que ninguna rama mejora (o se
   * acaba el tiempo); las ramas muy grandes se reintentan con más margen.
   */
  improve(root, seconds = 10) {
    this.deadline = performance.now() + seconds * 1000;
    this.altCap = 0;
    let cuota = 100_000;  // nodos por rama; si no alcanza, se agranda mientras quede tiempo
    try {
      for (;;) {
        let mejoro = false, salteadas = false;
        // Primero las ramas chicas (se resuelven rápido), después las grandes.
        const ramas = breedsOf(root).sort((a, b) => a[1].cost - b[1].cost);
        for (const [path, node] of ramas) {
          const [nuevo, completa] = this.resolverRama(root, path, node, cuota);
          if (nuevo !== null) {
            root = reemplazar(root, path, nuevo);
            mejoro = true;
            break;
          }
          if (!completa) salteadas = true;
          else if (!path.length) {
            // Se revisó entero el árbol completo sin encontrar nada más barato:
            // es la ruta más barata posible.
            this.optimal = true;
            return root;
          }
        }
        if (mejoro) continue;
        if (!salteadas) break;  // ninguna rama se puede mejorar sola
        cuota *= 4;             // quedan ramas grandes sin revisar: más margen
      }
    } catch (e) {
      if (!(e instanceof SearchLimit)) throw e;
    }
    return root;
  }

  /** Busca la rama `node` más barata con lo que el resto no usa -> [rama nueva o null, si se revisó entera]. */
  resolverRama(root, path, node, cuota) {
    let req = node.req;
    if (path.length && path[path.length - 1] === 1) {
      // Es la madre de un cruce: define la especie de esa cría (y con quién
      // puede cruzarse el padre), así que el reemplazo tiene que ser de la misma.
      req = new Req(req.mask, req.gender, ["exact", node.species], req.natured, req.ditto);
    }
    const mios = new Set(leavesOf(node).map(l => l.mon.uid));
    const otros = leavesOf(root).map(l => l.mon.uid).filter(u => !mios.has(u));
    for (let b = this.bound(req); b < node.cost; b++) {
      this.used.clear();
      for (const u of otros) this.used.add(this.idx.get(u));
      let plan;
      try {
        plan = this.primero(req, b, cuota);
      } catch (e) {
        if (e instanceof AttemptLimit) return [null, false];  // rama muy grande para esta cuota
        throw e;
      }
      if (plan) return [plan, true];
    }
    return [null, true];
  }
}

export function leavesOf(n) {
  return n instanceof Leaf ? [n] : [...leavesOf(n.p1), ...leavesOf(n.p2)];
}

function breedsOf(n, path = []) {
  if (n instanceof Leaf) return [];
  return [...breedsOf(n.p1, [...path, 1]), ...breedsOf(n.p2, [...path, 2]), [path, n]];
}

/** Cambia la rama en `path` y recalcula genes y costo de los cruces de arriba. */
function reemplazar(n, path, nuevo) {
  if (!path.length) return nuevo;
  const p1 = path[0] === 1 ? reemplazar(n.p1, path.slice(1), nuevo) : n.p1;
  const p2 = path[0] === 2 ? reemplazar(n.p2, path.slice(1), nuevo) : n.p2;
  let mask = p1.mask & p2.mask;
  for (const it of [n.item1, n.item2]) if (typeof it === "number") mask |= 1 << it;
  const propio = n.cost - n.p1.cost - n.p2.cost;  // lo que vale el cruce en sí
  return n.with({ p1, p2, mask, cost: propio + p1.cost + p2.cost });
}

export function countBreeds(n) {
  return n instanceof Leaf ? 0 : 1 + countBreeds(n.p1) + countBreeds(n.p2);
}
