import { config } from 'zod'

// Zod 4 decide si compila sus parsers (`new Function`) al construir cada schema, no al validar: por eso esta
// configuración vive en un módulo aparte que el arranque importa antes que `@strata/contracts`. Bajo una CSP
// sin `unsafe-eval` (renderer, preload) evita que cada arranque registre una violación de `eval` inofensiva.
config({ jitless: true })
