# NexMind — Tu Cerebro Personal con IA

Sistema de memoria neuronal personal con Claude como motor.

## Características

- 💬 **Chat con memoria persistente** — Claude recuerda todo entre conversaciones
- 👤 **Contactos** — Gestión completa de personas y empresas  
- 📅 **Agenda** — Calendario visual con eventos conectados a contactos
- ✅ **Tareas** — Kanban board con prioridades
- 💰 **Finanzas** — Contabilidad personal con balance en tiempo real
- 📁 **Proyectos** — Seguimiento de proyectos y clientes
- 🔗 **Grafo** — Visualización de relaciones entre entidades
- 🌐 **ES/EN** — Switch de idioma instantáneo

## Instalación rápida

### 1. Prerequisitos
- Docker Desktop instalado
- API key de Anthropic (console.anthropic.com)

### 2. Configurar
```bash
# Copia y edita el archivo .env
cp .env.example .env
# Edita .env y agrega tu ANTHROPIC_API_KEY
```

### 3. Levantar
```bash
docker-compose up -d
```

### 4. Abrir
```
http://localhost:3000
```

## Cómo funciona la memoria

Cada mensaje que envías pasa por dos procesos simultáneos:

1. **Extracción de entidades**: Claude analiza el texto y detecta automáticamente
   contactos, eventos, transacciones, tareas, proyectos y los guarda en SQLite

2. **Contexto de memoria**: Antes de responder, el sistema inyecta toda la
   información existente en el contexto de Claude para respuestas personalizadas

## Ejemplos de uso natural

```
"Agrega a María López, email: maria@corp.com, trabaja en Acme Inc"
→ Crea contacto + empresa + relación automáticamente

"Le cobré $3,500 a María por el proyecto de diseño"  
→ Registra transacción + la vincula al contacto existente

"Agenda una reunión con María el viernes a las 3pm en su oficina"
→ Crea evento vinculado al contacto

"Crea tarea urgente: enviar factura a María antes del viernes"
→ Crea tarea con prioridad y fecha límite

"¿Cuánto me debe María en total?"
→ Claude consulta la memoria y calcula automáticamente
```

## Estructura del proyecto

```
nexmind/
├── server.js          # API Express + lógica de memoria
├── db.js              # SQLite + grafo de relaciones  
├── public/
│   └── index.html     # Frontend completo (single file)
├── db/                # Base de datos SQLite (persistente)
├── uploads/           # Archivos adjuntos
├── Dockerfile
├── docker-compose.yml
└── .env
```

## Acceso remoto (opcional)

Para acceder desde iPhone o fuera de casa, configura Cloudflare Tunnel:

```bash
# Instalar cloudflared
# Crear tunnel apuntando a http://localhost:3000
cloudflared tunnel run --url http://localhost:3000
```
