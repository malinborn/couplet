# md-mini ahora es couplet

**Powerful for you and your AI, yet minimalistic.**

La misma app, las mismas funciones de IA, un nombre nuevo. Todo lo que tenías se ha trasladado solo: las ventanas abiertas, la posición del cursor, los borradores sin guardar, las copias de recuperación, tu tema y tus archivos recientes.

## Qué hacer — una vez, un par de minutos

1. **Reinicia las sesiones de tus agentes de IA.** Una sesión abierta antes de la actualización sigue conectada al antiguo md-mini y no verá couplet hasta que la reinicies.
2. **Vuelve a enseñar a tu agente.** Abre **IA → Enseña couplet a tu IA**, copia el prompt y dáselo a tu agente. Registrará el servidor MCP `couplet` en lugar de `mdmini`, sustituirá la skill `mdmini` por `couplet`, actualizará la nota en `CLAUDE.md` (o en la configuración de tu agente) y al final te dirá qué ha cambiado.
3. **Si instalaste desde el DMG y no con Homebrew,** borra `/Applications/md-mini.app`. Tus datos ya están en couplet, y la app antigua, si la abres por error, arrancará vacía.

## Por qué cambiamos de nombre

**Hay dos apps que se llaman mdmini.** La otra tiene el dominio mdmini.com. Dos editores pequeños con el mismo nombre significan búsquedas confusas, alguna descarga equivocada e informes de errores sobre la app de otra persona. No queríamos que eso fuera tu problema, así que nos hicimos a un lado en lugar de pelear por el nombre.

**Y el nombre antiguo había dejado de decir la verdad.** md-mini nació como un editor de markdown minimalista. En lo que se ha convertido es en una página en la que tú y tu agente de IA trabajáis juntos. El agente te lleva a una línea, reescribe el documento abierto mientras miras, pregunta con botones de verdad y responde a los comentarios que dejas en el margen. Un couplet es un pareado: dos versos que se leen como uno, y esa es ahora la idea. El minimalismo se queda: es nuestra forma de construir, solo que ya no es todo el sentido.

## Qué sigue funcionando aunque no hagas nada

| | |
|---|---|
| **Terminal** | `mdmini` sigue funcionando como segundo nombre de `couplet`, junto al corto `coup`. Los scripts, los alias y `$EDITOR` no necesitan cambios. |
| **Agentes de IA** | Un registro MCP con el nombre `mdmini` seguirá funcionando después de reiniciar el agente, siempre que llame al comando `mdmini`: así lo configuraba «Teach Your AI». Un registro con la ruta completa a `md-mini.app` dejará de funcionar: lo arregla el paso 2. |
| **Homebrew** | `brew upgrade --cask mdmini` te pasa a couplet y sigue funcionando después. |
| **Tus datos** | Se trasladaron de la carpeta de md-mini a la de couplet en el primer arranque. En la carpeta de md-mini queda una nota que dice adónde se fueron. |

## Dónde encontrarnos

La web ahora es **couplet.pro**, y la antigua dirección md-mini.com lleva al mismo sitio. El código sigue donde estaba, en GitHub.

Gracias por estar aquí desde el principio. El cuaderno es el mismo, solo que ahora tiene un nombre que encaja mejor con lo que hace.
