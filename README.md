# PokeCrianza — Generador de Árboles de Crianza

Arma el árbol de crianza más barato para conseguir un Pokémon con los IVs que querés, usando los
Pokémon de tu PC de Cobblemon (reglas de PokeMMO: grupos huevo, Objetos Recios, Piedra Eterna, Ditto).

Todo corre **en el navegador** (JavaScript): no hace falta instalar nada para usarlo desde la web.

## Usarlo

- **Desde la web:** abrí la dirección de GitHub Pages (ver abajo cómo publicarla).
- **En tu computadora, sin internet:** doble clic en `iniciar.bat` (necesita [Python](https://www.python.org/downloads/),
  solo para servir los archivos). Se abre en `http://127.0.0.1:8765/`.

Exportá tu PC desde Cobblemon (queda en `cobblemon_exports/` dentro de la carpeta de tu instancia) y
cargá ese `.txt` en el paso 1 de la página. Tus árboles se guardan en tu navegador.
Para probar sin tu PC: `ejemplo_pc.txt` o `ejemplo_pc_grande.txt`.

## Publicarlo gratis en GitHub Pages

1. Creá una cuenta en https://github.com y un repositorio **público** nuevo (por ejemplo `pokecrianza`),
   sin README.
2. Subí esta carpeta. Desde una terminal, dentro de la carpeta del proyecto:
   ```
   git init
   git add .
   git commit -m "PokeCrianza"
   git branch -M main
   git remote add origin https://github.com/TU_USUARIO/pokecrianza.git
   git push -u origin main
   ```
   (`.gitignore` deja afuera lo que no hace falta subir.)
3. En el repositorio: **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
   rama **main**, carpeta **/docs**, y **Save**.
4. En un par de minutos queda en `https://412192-garcia.github.io/PokeCrianza-Diosesmon/`.

Para actualizarlo después: `git add .`, `git commit -m "cambios"` y `git push`.

## Cómo está hecho

| Archivo | Qué hace |
|---|---|
| `docs/index.html` | La página (formulario, árbol, pasos, pestañas, exportar imagen) |
| `docs/motor/parser.js` | Lee el export del PC: apóstrofes, apodos, objetos, formas regionales, descarta shinies |
| `docs/motor/dex.js` | Grupos huevo, género y qué especie nace, desde el `pokedex.json` de Showdown |
| `docs/motor/planner.js` | La búsqueda: backtracking con consumo de padres, superposición de IVs, Piedra Eterna, Ditto, y mejora rama por rama |
| `docs/motor/cotas.js` | Cota inferior por programación dinámica, para podar la búsqueda |
| `docs/motor/servicio.js` | Arma la respuesta, los filtros de búsqueda de la caja y el diagnóstico de qué falta |
| `docs/motor/worker.js`, `cliente.js` | Corren el cálculo en segundo plano (Web Workers) para que la página no se congele |
| `servidor.py` | Servidor local mínimo para usarlo sin internet |

**Ruta más barata:** el costo de un árbol es (peso del cruce × nº de cruces) + el valor de cada Pokémon
consumido, donde uno con k IVs útiles vale 2^(k-1) (1x31 = 1, 2x31 = 2, 3x31 = 4…) y uno sin IVs útiles
no vale nada. El peso del cruce sale de la opción "Prioridad" (Menos cruces = 4, Equilibrado = 2,
Cuidar mis Pokémon = 1).

Supuestos: se puede elegir el género de la cría pagando. Los bebés (Pichu, Happiny...) se saltan: la cría
se toma como la primera forma que puede criar. Casos especiales como Nidoran♀→♂ o Volbeat/Illumise no se modelan.
