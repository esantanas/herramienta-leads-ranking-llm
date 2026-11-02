# Herramienta Score de Leads

## 1. Contexto

Lidz es una plataforma tecnológica destinada a facilitar la venta de propiedades. Desde Lidz, se asevera que las principales dificultades a la hora de vender una propiedad, vienen de tareas repetitivas, seguimientos tardíos, y una toma de decisiones sin datos que las fundamenten. Esto impacta negativamente tanto al entorno corporativo como la sostenibilidad de un proyecto, viéndose reflejado principalmente en un equipo fatigado (por realizar tareas repetitivas, sin valor estratégico), oportunidades frías (ocasionadas por seguimiento tardío) y, principalmente, una baja tasa de conversión.

En este sentido, Lidz se posiciona como una tecnología construida para el ciclo de venta del inmobiliario, a través de agentes de IA conversacional, se realiza calificación y perfilamiento de oportunidades, seguimiento inteligente en tiempo real y reportería accionable. Así, no tan solo un lead que se pudo haber enfriado se transforma en un prospecto, sino que también se ordenan y centralizan todos los procesos de venta y negocio, se hace auditable el funnel de ventas, se reduce la carga operativa, y por supuesto, suben las ventas.

En el presente proyecto, que aborda una prueba técnica desarrollada por Lidz.ai, se presenta un contexto donde el proyecto “Mirador Ñuñoa”, recibe cientos de mensajes a través de WhatsApp diariamente. Si bien un asistente con IA responde, los ejecutivos comerciales no son capaces de leer todas las conversaciones, en ese sentido, tampoco pueden identificar cuáles son las oportunidades más relevantes o urgentes sin comprometer una enorme cantidad de tiempo. Como consecuencia de ello se escapan leads calientes, y se pierde tiempo con otras consultas que o bien no son tan urgentes, o bien son mensajes hechos por equivocación. Quienes padecen esta problemática (ejecutivos de venta) señalan que necesitan conocer las siguientes características de cada conversación:

- Intención (comprar, invertir, consulta, reclamo, otro).
- Urgencia por concretar.
- Presupuesto.
- Tipo de departamento.
- Requerimiento de intervención humana.
- Resumen breve para decidir.

Por otro lado, es bien sabido que los modelos de lenguaje suelen inventar cuando no tienen información respecto a algo (alucinación). En este sentido el equipo técnico que desarrolló la prueba, pone particular énfasis en que la herramienta (propulsada por un llm) no alucine, dado que información inventada puede afectar la venta de un ejecutivo, ocasionando que este pierda su confianza en la herramienta para siempre, recordemos que para un ejecutivo de venta la herramienta es un soporte de su medio de vida, una persona sin formación en ingeniería de software al presentarse un fallo de la herramienta, no necesariamente piensa “fue un bug, reportable para corregir”, al contrario pensará que la herramienta no es confiable y le hará perder comisiones. No tan solo eso, sino que los humanos solemos presentar un sesgo de confirmación, lo que nos hace fijarnos exclusivamente en evidencia que confirme nuestras creencias (muchas veces ignorando evidencia sustancial, sin embargo, el software para el usuario final es una caja negra.) En este sentido, una eventual discontinuance (abandono de la herramienta) ocasionada por una alucinación, no tan solo repercute en el medio de vida del ejecutivo, sino también en las ventas de la inmobiliaria y la reputación de las soluciones ofrecidas por Lidz. Para desarrollar esta herramienta se me ha hecho llegar un archivo de formato JSON que contempla 10 conversaciones reales del proyecto mirador ñuñoa, Están diversificadas a propósito para evaluar la identificación de leads buenos, curiosos, gente equivocada, etc. Además, una API Key de Gemini con límite de gasto.

Asimismo, la solución ha de ser entregada funcionando en TypeScript y lista para ser usada en otro sistema de Lidz. Junto a los resultados de pasar las 10 conversaciones por la herramienta, por supuesto también se ha de proveer que el sistema funcionará y seguirá como tal una vez alguien lo toque, y el presente README.md que responda cómo correr la herramienta, defensa de las decisiones de diseño, costos asociados, y escalabilidad.

## 2. Arquitectura del pipeline

Para solucionar la problemática recién expuesta, propongo el siguiente pipeline:

```text
[ ENTRADA ]
Conversación lead / asistente
(JSON con id + mensajes)
       │
       ▼
+------------------+     +-----------------------------------+
| PREPROCESAMIENTO | --> |  LLM (probabilístico)             |
|  validación zod  |     |  +-----------------------------+  |
|  filtro + cache  |     |  |       GEMINI LLM API        |  |
+------------------+     |  | 1 llamada, JSON + citas     |  |
                         |  +--------------+--------------+  |
                         +-----------------+-----------------+
                                           │
                                           ▼
                         +-----------------------------------+
                         |  CÓDIGO (determinista, sin LLM)   |
                         |  +-----------------------------+  |
                         |  |      VALIDATE EVIDENCE      |  |
                         |  | cita literal del LEAD o se  |  |
                         |  | anula (queda en audit[])    |  |
                         |  +--------------+--------------+  |
                         |                 │                 |
                         |                 ▼                 |
                         |  +-----------------------------+  |
                         |  |           SCORING           |  |
                         |  | reglas + pesos -> prioridad |  |
                         |  | y razones (el "porqué")     |  |
                         |  +--------------+--------------+  |
                         +-----------------+-----------------+
                                           │
                                           ▼
                                      [ SALIDA ]
                          JSON: prioridad + razones + audit[]
```

El pipeline expuesto no tiene por objetivo tan solo solucionar la problemática, sino también realizarlo de una manera eficiente (costos por tokens) a la vez que se contempla con confiabilidad por diseño. Esto se aprecia, en primer lugar, en que el pipeline limita a una sola llamada al LLM por conversación, donde se devuelven todos los campos solicitados al LLM en un archivo JSON validado contra un schema dada la imprevisibilidad de las IA’s. En esta etapa, el LLM se limita a extraer hechos, dado que la prioridad se designará por código, Gemini se limitará a decir qué campos incluye la conversación, con la respectiva extracción de texto (de la conversación) que lo respalde, esto toma a lugar en el bloque de validación de evidencia, más adelante, se profundizará cómo se manejan eventuales excepciones en este caso. Sin embargo, de momento podemos decir que la arquitectura propuesta presta particular atención a los falsos positivos, es decir, se prefiere perder un dato real antes que entregarle un dato erróneo al ejecutivo, dado el riesgo de discontinuidad, que me motiva a tomar un enfoque de Trust by Design. Por último, la prioridad la decide el código en TypeScript, a través de reglas y pesos fijos auditables, asimismo, cada prioridad es acompañada de las respectivas razones.

## 3. Decisiones de diseño

En la presente sección se discutirán las principales decisiones de diseño, justificando porqué se tomaron, en consideración del modelo de negocio de Lidz, y el enunciado provisto por el equipo TI, no solo limitándonos a sus “pros” sino también explicitar qué limitaciones presentarían, y porqué, aún presentando dichas limitaciones, son una mejor opción de diseño que otras.

### 1. Scoring determinista

Delegar toda la responsabilidad del pipeline en el LLM, no tan solo generaría un prompt más extenso y en tanto, más costoso, sino que también, generaría inestabilidad en los criterios de clasificación al depender estos de un árbitro externo al negocio. Asimismo, el cómo se toman las decisiones de priorización sería una caja negra sin trazabilidad. En este sentido, he priorizado, el limitar al LLM a solo devolver hechos (intención, urgencia, presupuesto, entre otros). De manera que el criterio de negocio reside principalmente en TypeScript, particularmente en el código fuente de scoring.ts, dónde las conversaciones se sopesan mediante una función scorePriority(), que a través de pesos asignados a cada campo (intención, urgencia, presupuesto, etc) y umbrales (≥3 prioridad media, ≥5 prioridad alta) no solo devuelve la prioridad asignada y su score, sino que también las razones que respaldan dicho score. por ejemplo, la salida de scorePriority para la conversación 5, el caso de lead más caliente, la salida es esta:

```
“priority”: “alta”,
“priority_reasons”: [
	“urgencia alta (+3)”,
	“presupuesto declarado (+2)”,
	“tipo de propiedad definido (+1)”,
	“crédito preaprobado (+2)”,
	“score 8 → alta”
	],
“is_actionable”: true
```

Vale aclarar que no tan solo es determinista el sistema de puntuación, sino que como “barrera”, implementé un tope de seguridad, configurando que para cada extracción del llm con confianza menor a 0,4, el lead nunca puede estar más arriba de la prioridad “baja”.

Por todo lo anterior, se puede aseverar que se gana en reproducibilidad (se puede testear sin red), auditabilidad, y en libertad de recalibrar sin tocar el prompt de Gemini.

Sin embargo, no es todo bueno, al ser determinista, los matices no entran en las reglas, por ejemplo frases ambiguas como “lo voy a pensar” que en la mayoría de los casos es un no, son señales que un LLM sí interpretar como “no”. Por otro lado, los pesos que se les asignó a cada casos son supuestos hipotéticos, no están respaldados con datos de mercado. Por último, al ser código fuente necesario de compilar, si se requiere cambiar algo, es necesario un nuevo deploy.

### 2. Validación estricta de evidencia (anti-alucinaciones)

Como se ha mencionado extensamente a lo largo del documento, el riesgo de los LLM son las alucinaciones, en momentos donde se le pide información que no tiene, no solo es capaz de inventar nueva información, sino de tergiversar la ya disponible. Por ejemplo, el Asistente de WhatsApp puede mencionar precios de catálogo y que por error, gemini atribuya ese presupuesto al cliente. Si eso se tomara como presupuesto, la prioridad en vez de ser media pasaría a ser alta, por ejemplo, en el primer caso del json provisto por Lidz. Si un ejecutivo llamará aseverando que un cliente cuenta con un presupuesto de 4.200 UF, se pierde credibilidad y quizás el cliente, además de que el ejecutivo tome como prioridad alta un caso de prioridad media.

Para solucionar esto, se implementa el módulo “validateEvidence.ts” donde su función principal normaliza el texto y exige que la cita sea un substring literal del texto del lead. Esto se limita al texto del cliente, por su parte el del asistente nunca se valida, puesto lo que hemos comentado anteriormente. Si la cita no hace match con la interpretación del LLM, el campo se degrada. Por ejemplo, valor obtendría un valor nulo (null).

En este caso el trade-off es ganar cero datos atribuidos al cliente sin evidencia, además de obtener una amplia trazabilidad. Sin embargo es a costo de sacrificar falsos negativos, al perder el input del Asistente de WhatsApp, estamos expuestos a perder datos verdaderos. Sin embargo se ha utilizado el criterio de asimetría de costos, el costo de un falso negativo es menor que el de un falso positivo, en tanto este último compromete la confianza en la herramienta.

### 3. Schema.ts

La salida de un LLM no es siempre confiable en su formato. En corridas reales se obtuvieron json truncados (maxOutputTokens:800), o también eventualmente podrían llegar respuestas vacías o con texto contaminando el formato. Un dato mal formateado puede llegar al scoring y romperlo, asimismo pueden existir inconsistencias internas. Por ejemplo, budget con valor null, mientras que budget_evidence sea “UF 4200”.

Por ello, el archivo schema.ts decide tratar al json que entrega gemini como no confiable, igual que el formulario que llena un usuario. Antes de que lo use cualquier parte del sistema, debe pasar por RawLlmOutputSchema, para normalizar tipos, enums, rangos objetos estrictos y 8 reglas cruzadas. En caso de un eventual fallo, el error queda tipado y con nombre: parse, max_tokens, empty_response, etc. De igual manera se decidió incluir el texto crudo para depurar, y la conversación se marca como error sin detener el batch.

En este sentido resulta bastante útil, puesto que una vez los datos pasan al validador, o al scoring, podemos asumir que los datos tienen la forma correcta, por otro lado las fallas son trazables, el log dirá “max_tokens” en vez de un TypeError misterioso.

Sin embargo, el sistema es demasiado rígido, una respuesta casi correcta, como por ejemplo, incluir por error tan solo un campo extra, se rechaza. Se ha de repetir la llamada y cuesta tokens de más. Por otro lado, se dificulta la mantención del código en tanto agregar un campo exige tocar el schema Zod, RESPONSE_SCHEMA, el prompt y los tests.

Mas, como hemos comentado, así nos aseguramos que en el dashboard solo lleguen datos veraces.

### 4. Intervención humana.

El flag “needs_human_intervention” se limita a casos donde el bot no es capaz de resolver la conversación. Por ejemplo reclamos, consultas por el subsidio DS19, negociación, intentos de manipulación, entre otros. En este sentido no marca a los leads buenos, porque si sumamos +2 al score: si se activara con leads con presupuesto y urgencia, esos leads sumarían dos veces lo mismo. En particular, la primera conversación pasaría de media a alta sin ningún dato nuevo.

El beneficio es que cada señal mide una sola cosa, la calidad sale del presupuesto, la urgencia y el crédito, por su parte la intervención surge exclusivamente del bloqueo del bot. En este sentido el costo es el sector menos trazable del proyecto, dado que no hay cita de evidencia, y la razón de intervención es texto libre del LLM, así que el validador no lo cubre.

Por lo expuesto en esta sección, reconozco esta decisión como la más discutible, dado que sumar +2 se justificaría en el caso 7, dado que es un caso más complejo que requiere atención humana antes que se enfríe, sin embargo se confundiría la “urgencia de atención” con la cercanía a la compra. Una alternativa que también contemplé sería enrutarlo a una cola aparte en vez de sumarlo al score.

## 4. Métricas y Costos

El presente producto no se limita a clasificar cada conversación. Además, cada ejecución genera un bloque de métricas que resume el estado del embudo de leads. Esto permite tomar decisiones sobre el canal y el bot, no sobre leads individuales.

| Métrica                               | Qué mide                                                                         | Para qué sirve a Lidz                                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| actionable_rate                       | % de conversaciones con prioridad alta o media                                   | Cuánto del tráfico merece la atención de un ejecutivo                                                 |
| by_priority / by_intent               | Distribución por prioridad e intención                                           | Detectar cambios en la calidad del tráfico (ej. más consultas que compras)                            |
| fields_missing_rate.budget / .urgency | % de conversaciones sin presupuesto o sin plazo declarado                        | Señal para mejorar el guion del bot: si casi nadie declara presupuesto, el bot no lo está preguntando |
| needs_human_count                     | Casos que el bot no puede resolver (reclamos, DS19, manipulación)                | Dimensionar la carga de atención humana                                                               |
| avg_confidence                        | Confianza promedio de la extracción                                              | Monitorear degradación del modelo o del prompt                                                        |
| estimated_time_saved_minutes          | 3,5 min por cada conversación no accionable que el ejecutivo ya no necesita leer | Estimación conservadora del ahorro operativo                                                          |

Resultado de la corrida sobre las 10 conversaciones reales:

```json
{
  "total": 10,
  "by_intent": {
    "comprar": 4,
    "alquilar": 1,
    "invertir": 1,
    "no_lead": 1,
    "consulta": 1,
    "reclamo": 1,
    "intento_manipulacion": 1
  },
  "by_priority": {
    "media": 3,
    "descartar": 3,
    "alta": 2,
    "baja": 2
  },
  "actionable_rate": 0.5,
  "needs_human_count": 3,
  "fields_missing_rate": {
    "budget": 0.8,
    "urgency": 0.7
  },
  "avg_confidence": 0.95,
  "estimated_time_saved_minutes": 17.5
}
```

En lo relativo a los costos, cada llamada a Gemini registra sus tokens reales y el costo se calcula con la tarifa vigente del modelo.

| Métrica                | Valor                                                                       |
| :--------------------- | :-------------------------------------------------------------------------- |
| Modelo                 | `gemini-3.6-flash` ($0,75 / $3,75 por millón de tokens de entrada / salida) |
| Llamadas al LLM        | 10 (1 por conversación, sin reintentos)                                     |
| Tokens de entrada      | 33.341 (~3.330 por conversación)                                            |
| Tokens de salida       | 3.054 (~305 por conversación)                                               |
| Tokens totales         | 36.395                                                                      |
| Costo total\*          | $0,0365 USD                                                                 |
| Costo por conversación | $0,0035 – $0,0039 USD (promedio $0,0036)                                    |
| Latencia por llamada   | ~3,5 s                                                                      |

A la tarifa actual, procesar 1.000 conversaciones costaría solo unos 3,65 USD. El código ya está preparado por si la tarifa de Gemini sube en 2027, ajustando el cálculo automáticamente en el archivo batch.ts.
Respecto a de dónde viene este costo, el 92% de los tokens son de entrada. La mayor parte de eso es el system prompt (las reglas, el catálogo y los ejemplos), que es idéntico en cada llamada. La conversación en sí y la respuesta del LLM, son una fracción menor.
El costo por conversación es tan bajo porque usamos una sola llamada por chat, sin cadenas de prompts ni un segundo LLM para verificar. La validación y el scoring son código puro, lo cual nos cuesta cero. Además, el preprocess descarta chats vacíos (como solo emojis) antes de gastar tokens. En las 10 pruebas no se activó porque todas tenían contenido, pero en la vida real pasa mucho. También contamos con caché, así que si una misma conversación llega dos veces, el sistema la guarda y no la vuelve a pagar. Los reintentos también están controlados, porque si la API de Google se cae o se agota la cuota, el sistema se detiene en lugar de seguir gastando en vano.
Como optimización futura, dado que el system prompt se repite en cada llamada, usar la función de context caching de Gemini nos permitiría cobrar esos 3.200 tokens a una fracción del precio. Es la palanca de ahorro más grande que queda.

## 5. Despliegue y Mantenibilidad

### Despliegue en producción

La API está desplegada en Google Cloud Run y disponible en:
https://inmo-analyzer-678206493295.us-central1.run.app

| Endpoint       | Método | Descripción                                                 |
| -------------- | ------ | ----------------------------------------------------------- |
| /health        | GET    | Estado del servicio                                         |
| /analyze       | POST   | Analiza una conversación                                    |
| /analyze/batch | POST   | Analiza hasta 100 conversaciones en serie                   |
| /metrics/cost  | GET    | Tokens y latencia acumulados desde que arrancó la instancia |

#### Probar /analyze

##### PowerShell (recomendado en Windows)

```powershell
$body = @'
{
  "conversation": {
    "id": "demo-001",
    "mensajes": [
      { "de": "lead", "texto": "Necesito un depto YA, me tengo que salir de mi arriendo el 30. Tienen algo de 1 dormitorio? Maximo 3.500 UF, tengo preaprobado el credito." }
    ]
  }
}
'@
Invoke-RestMethod -Method Post -Uri "https://inmo-analyzer-678206493295.us-central1.run.app/analyze" -ContentType "application/json" -Body $body | ConvertTo-Json -Depth 5
```

##### CMD

```bat
curl.exe -X POST "https://inmo-analyzer-678206493295.us-central1.run.app/analyze" -H "Content-Type: application/json" -d "{\"conversation\":{\"id\":\"demo-001\",\"mensajes\":[{\"de\":\"lead\",\"texto\":\"Necesito un depto YA, me tengo que salir de mi arriendo el 30. Tienen algo de 1 dormitorio? Maximo 3.500 UF, tengo preaprobado el credito.\"}]}}"
```

##### macOS/Linux

```bash
curl -X POST "https://inmo-analyzer-678206493295.us-central1.run.app/analyze" \
  -H "Content-Type: application/json" \
  -d '{"conversation":{"id":"demo-001","mensajes":[{"de":"lead","texto":"Necesito un depto YA, me tengo que salir de mi arriendo el 30. Tienen algo de 1 dormitorio? Maximo 3.500 UF, tengo preaprobado el credito."}]}}'
```

La respuesta es un contrato estricto a pesar de que el resumen o la confianza del LLM puedan variar entre ejecuciones. Sin embargo lo importante es que la prioridad siempre será la misma, porque como vimos anteriormente las reglas son determinísticas a partir de evidencia.

```json
{
  "conversation_id": "demo-001",
  "intent": "comprar",
  "urgency": "alta",
  "budget": { "amount": 3500, "currency": "UF", "scope": "total" },
  "down_payment": null,
  "property_type": "1D",
  "has_preapproved_credit": true,
  "seeks_subsidy": false,
  "out_of_scope": false,
  "rejected_alternatives": false,
  "needs_human_intervention": false,
  "intervention_reason": null,
  "one_line_summary": "Busca depto 1D con entrega inmediata antes del 30, presupuesto máx. UF 3.500 y crédito preaprobado.",
  "confidence": 0.95,
  "audit": [],
  "priority": "alta",
  "priority_reasons": [
    "urgencia alta (+3)",
    "presupuesto declarado (+2)",
    "tipo de propiedad definido (+1)",
    "crédito preaprobado (+2)",
    "score 8 → alta"
  ],
  "is_actionable": true
}
```

### Seguridad

Dado que la herramienta opera con una API Key de pago, consideré indispensable que dicha credencial nunca forme parte del código ni del repositorio. En el entorno de desarrollo, la clave reside en un archivo .env local, el cual está excluido tanto por .gitignore como por .dockerignore, de modo que tampoco queda contenida en la imagen Docker. En producción, en cambio, la clave se almacena en Google Secret Manager, y es Cloud Run quien la inyecta como variable de entorno al momento de arrancar el contenedor.

Asimismo, apliqué el principio de mínimo privilegio: la cuenta de servicio de Cloud Run cuenta únicamente con el rol Secret Manager Secret Accessor sobre ese secreto en particular, lo que le permite leerlo, pero no modificarlo ni acceder a otros secretos del proyecto. Una consecuencia favorable de este diseño es que rotar la clave se reduce a crear una nueva versión del secreto, sin necesidad de modificar el código ni de reconstruir la imagen.

Por último, y en consideración de que una API Key limitada es también un recurso finito, implementé mecanismos para acotar el consumo. El servicio corre con --max-instances 1 y con un límite de requests por minuto hacia Gemini (GEMINI_MAX_RPM), lo que restringe el gasto máximo aun cuando el endpoint reciba un volumen elevado de tráfico. De igual manera, el endpoint /analyze/batch está limitado a 100 conversaciones por request.

### Calidad y testing

Con el objetivo de asegurar la mantenibilidad del sistema ante futuros cambios, diseñé una suite de 162 tests automatizados (npm test), que cubre el schema, el validador de evidencias, el scoring, el cliente de Gemini, la API HTTP y el batch. Dado que ninguno de estos tests realiza llamadas a la API real de Google, utilizo mocks que simulan respuestas válidas, errores 429/503, timeouts y respuestas truncadas, lo que garantiza una ejecución determinista, de aproximadamente 3 segundos y sin costos de tokens.

Además de los tests unitarios, incorporé dos capas de verificación orientadas al negocio. En primer lugar, golden.real.test.ts recorre las 10 conversaciones reales y verifica que cada una obtenga exactamente la prioridad acordada, de manera que cualquier recalibración de pesos o reglas que altere la clasificación de un caso real queda en evidencia de inmediato. En segundo lugar, regression.paraphrase.test.ts inyecta errores típicos del LLM, como citas parafraseadas, montos reordenados o precios del asistente atribuidos al lead, con el fin de demostrar cómo responde el sistema ante cada uno de ellos. Vale aclarar que este último archivo también documenta el límite conocido del validador, a saber, que verifica la existencia de la cita y no su significado.

### CI/CD

Para que la suite de tests no dependa de que alguien recuerde ejecutarla, configuré un workflow de GitHub Actions (.github/workflows/test.yml) que, en cada push a la rama main, instala las dependencias y corre la suite completa. En este sentido, si algún cambio rompe el validador, el scoring o el contrato de datos, el commit queda marcado en rojo antes de llegar a producción.

## 6. Limitaciones conocidas y mejora continua

Es bien sabido que un sistema confiable no es el que no tiene fallas, pues todos las tienen, sino aquel que las hace explícitas y medibles. En consecuencia con el enfoque de Trust by Design que inspira este proyecto, a continuación expongo los límites que presenta actualmente la herramienta, junto con la forma en que los abordaría en una siguiente iteración.

### 1. El validador de evidencias verifica existencia, no significado

El módulo validateEvidence.ts constituye una garantía sólida contra datos inventados o atribuidos al asistente. Sin embargo, reconozco que presenta tres puntos ciegos, los cuales documenté en regression.paraphrase.test.ts:

- Falsos negativos por paráfrasis: si el LLM resume "pie para unas UF 900" como "pie UF 900", la cita deja de ser literal y el dato se anula, aun cuando sea verdadero.
- Falsos positivos semánticos: "ingresos de 1.8 millones" existe literalmente en el texto, por lo que pasa como presupuesto aunque se trate de un ingreso mensual.
- Citas que cortan números: "UF 90" es substring de "UF 900" y pasaría la validación.

El primero de estos puntos es un trade-off que asumí deliberadamente, puesto que prefiero perder un dato verdadero antes que entregarle uno falso al ejecutivo. Los otros dos, en cambio, dependen hoy de que el prompt resguarde la semántica. Si esta herramienta fuera a producción el día de mañana, mi primera mejora sería implementar una validación numérica en código, que extraiga los montos mediante expresiones regulares y verifique los límites de palabra, complementada con un modelo pequeño de verificación semántica aplicado únicamente a los campos que modifican la prioridad, como el presupuesto y el crédito. Asimismo, aprovecharía los datos que ya entrega el array audit[] en producción para medir la tasa de anulación por campo, de modo que cualquier relajación de las reglas se fundamente en evidencia y no en intuición.

### 2. El catálogo del proyecto está fijo en el system prompt

Actualmente, el catálogo de Mirador Ñuñoa, es decir, qué se vende y qué no, está hardcodeado en el prompt. Esto limita la herramienta a un solo proyecto y, además, hace que el prompt sea más pesado.

Una iteración futura requeriría cargar el catálogo de forma dinámica desde la base de datos de Lidz e inyectarlo en el mensaje de usuario, y no en el system prompt. De esta manera, el system prompt se mantendría idéntico en todas las llamadas, lo que permitiría aprovechar el context caching de Gemini, que a mi parecer eventualmente podría significar la mayor palanca de ahorro de costos. Por otro lado, considero que la decisión de "fuera de catálogo" podría migrar desde el LLM hacia una regla determinista en código, en coherencia con el criterio de que el LLM extraiga hechos y el código tome las decisiones.

### 3. El estado vive en memoria (falta de persistencia)

Con el propósito de mantener la prueba simple y sin dependencias externas, opté por que el caché de resultados, el contador de costos y el límite de requests vivan en la memoria RAM de la instancia. La consecuencia de esta decisión es que dichos datos se pierden si Cloud Run reinicia, y no se comparten si el servicio escala a más de una instancia, razón por la cual el servicio corre con --max-instances 1

En un escenario productivo, incorporaría Redis para compartir el caché y el rate limit entre instancias, lo que habilitaría el escalamiento horizontal. De igual manera, utilizaría PostgreSQL para persistir el historial auditable de cada análisis, almacenando el audit[] y los priority_reasons, y enviaría los logs de tokens reales a BigQuery para sostener una reportería de costos a largo plazo.

### 4. Falta de contexto entre conversaciones (Stateless)

El sistema analiza cada conversación de forma aislada. En consecuencia, si un cliente vuelve a escribir tres días después, el sistema no sabe quién es, no acierta el caché y lo analiza como si se tratara de un lead nuevo.

Para resolverlo, propongo identificar al lead por teléfono o lead_id y guardar su último análisis, de modo de implementar un análisis incremental, en el que al LLM solo se le envíen los mensajes nuevos y los hechos resultantes se fusionen con los ya verificados. Cabe destacar que el regreso de un lead constituye en sí mismo una señal de interés, por lo que un cambio relevante, como que ahora declare un crédito preaprobado, debería elevar su prioridad y notificar al ejecutivo.

### Otros límites a considerar

Reconozco, además, tres límites que no comprometen el funcionamiento actual, pero que condicionan la validez de los resultados a mayor escala. En primer lugar, las constantes WEIGHTS y THRESHOLDS son hipótesis de negocio y no están calibradas con datos reales; por ello, el paso natural sería registrar la prioridad asignada junto con el resultado efectivo de cada lead, es decir, si cerró o no la venta, y ajustar los pesos a partir de datos históricos.

En segundo lugar, existe un sesgo en la evaluación, dado que tres de las diez conversaciones de prueba (conv-001, 002 y 003) se utilizaron también como ejemplos en el prompt del LLM. Para medir con rigor si el prompt generaliza, se requeriría un set de evaluación separado que el modelo nunca haya visto.

Por último, la latencia es variable: gemini-3.6-flash respondió en promedio en ~3,5 segundos, pero en otras pruebas los tiempos llegaron a 20 o 110 segundos. Si el objetivo fuera responder en tiempo real, lo cual resulta deseable en un canal como WhatsApp, sería necesario un plan de pago con prioridad o bien un modelo más liviano.

## 7. Cómo correr la herramienta

Con el fin de que cualquier integrante del equipo pueda reproducir los resultados expuestos en este documento, detallo a continuación los pasos para ejecutar la herramienta. Los únicos requisitos son contar con Node.js 20 o superior y con una API Key de Gemini.

### Instalación y configuración

En primer lugar, se instalan las dependencias a partir del lockfile, lo que asegura las mismas versiones con las que fue probado el proyecto:

```powershell
npm ci
Copy-Item .env.example .env
```

El segundo comando crea el archivo .env a partir de la plantilla, donde se debe completar la API Key. La configuración con la que obtuve los resultados de la sección 4 es la siguiente:

```
GEMINI_API_KEY=tu_api_key
GEMINI_MODEL=gemini-3.6-flash
GEMINI_THINKING_LEVEL=low
GEMINI_THINKING_BUDGET=
GEMINI_TIMEOUT_MS=120000
GEMINI_MAX_RPM=5
```

Vale aclarar que GEMINI_THINKING_LEVEL (para modelos Gemini 3.x) y GEMINI_THINKING_BUDGET (para modelos 2.5) son excluyentes, por lo que uno de los dos debe quedar vacío; de lo contrario, el sistema se detiene al arrancar con un error de configuración. Asimismo, el valor GEMINI_MAX_RPM=5 corresponde al límite del tier gratuito, y puede aumentarse al utilizar una clave de pago.

### Tests

Recomiendo ejecutar la suite de tests antes que cualquier otro comando, dado que no consume tokens ni requiere conexión con Google:

```powershell
npm test
```

### Procesamiento batch

Para analizar las 10 conversaciones de data/conversaciones.json, se ejecuta:

```powershell
npm run batch
```

Este comando imprime en consola una tabla resumen y escribe tres archivos en la carpeta output: results.json, con el resultado completo de cada conversación; metrics.json, con las métricas agregadas; y costs.json, con los tokens reales y el costo estimado. En caso de que alguna conversación falle por un error transitorio, es posible reprocesar únicamente esa conversación, cuyo resultado se fusiona con los anteriores sin volver a pagar los que ya resultaron exitosos:

```powershell
npm run batch -- --only conv-002
```

### API local

Para levantar la API en http://localhost:3000, se ejecuta:

```powershell
npm run dev
```

O bien, compilando previamente el proyecto, tal como opera en producción:

```powershell
npm run build
npm start
```

### Despliegue en Cloud Run

Por último, un despliegue equivalente al descrito en la sección 5 puede replicarse con el siguiente comando, previa creación del secreto gemini-api-key en Secret Manager:

```bash
gcloud run deploy inmo-analyzer --source . --region us-central1 \
  --allow-unauthenticated --max-instances 1 --timeout 600 \
  --set-env-vars GEMINI_MODEL=gemini-3.6-flash,GEMINI_THINKING_LEVEL=low,GEMINI_TIMEOUT_MS=120000,GEMINI_MAX_RPM=5 \
  --set-secrets GEMINI_API_KEY=gemini-api-key:latest
```
