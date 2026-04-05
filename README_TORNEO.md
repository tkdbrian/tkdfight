# Sistema Round Robin Taekwondo - PORTABLE v1.0.0

## 📱 VERSIÓN PORTABLE - OFFLINE

Esta es la versión portable del Sistema Round Robin para Taekwondo, diseñada para funcionar completamente **sin conexión a internet**.

### 🚀 Inicio Rápido

**Opción 1 - Launcher automático (Windows):**
```
Doble clic en: Iniciar_Torneo_Simple.bat       (sin servidor)
Doble clic en: Iniciar_Torneo_Con_Jueces.bat   (jueces en red)
```

**Opción 2 - Manual:**
```
Doble clic en: index.html
```

### 📁 Archivos Incluidos

```
portable/
├── index.html              # Aplicación principal (sin dependencias externas)
├── script.js               # Lógica del torneo con todas las optimizaciones
├── styles.css              # Estilos completos para la interfaz
├── Iniciar_Torneo_Simple.bat      # Lanzador offline, un solo equipo
├── Iniciar_Torneo_Con_Jueces.bat  # Lanzador con servidor para jueces en red
├── LEEME.txt               # Guía del usuario
├── INSTRUCCIONES_TORNEO.txt # Guía para jueces y organizadores
└── README_TORNEO.md        # Esta documentación
```

### ✨ Características Principales

- **🌐 100% Offline**: Sin dependencias externas ni CDN
- **💾 Backup Automático**: Cada 30 segundos
- **🏆 Formatos Múltiples**: 3-8 competidores
- **⏱️ Cronómetro Avanzado**: Con penalizaciones integradas
- **👨‍⚖️ Panel de Jueces**: 4 jueces profesional
- **📊 Optimización**: Algoritmos para minimizar fatiga
- **🔒 Datos Seguros**: Almacenamiento local únicamente

### 🏆 Formatos Soportados

| Competidores | Formato | Peleas Totales |
|--------------|---------|----------------|
| 3 | Round Robin puro | 3 |
| 4 | Round Robin puro | 6 |
| 5 | Round Robin puro | 10 |
| 6 | 2 llaves de 3 + Final | 7 |
| 7 | 1 llave de 4 + 1 llave de 3 + Final | 8 |
| 8 | 2 llaves de 4 + Final | 13 |

### 🔧 Compatibilidad

**✅ Navegadores Soportados:**
- Google Chrome (recomendado)
- Mozilla Firefox
- Microsoft Edge
- Safari (macOS)

**❌ No Soportado:**
- Internet Explorer

### 💾 Sistema de Backup

**Backup Automático:**
- Intervalo: 30 segundos
- Almacenamiento: localStorage del navegador
- Persistencia: Entre sesiones
- Recuperación: Automática al recargar

**Backup Manual:**
- Exportación de resultados en formato texto
- Tabla de posiciones final
- Historial completo de peleas

### ⚙️ Configuración Técnica

**Dependencias Eliminadas:**
- ❌ Font Awesome CDN → ✅ Iconos embebidos
- ❌ CSS con versioning → ✅ CSS local
- ❌ JavaScript con versioning → ✅ JS local

**Optimizaciones Incluidas:**
- Algoritmos de programación de peleas
- Detección automática de finales
- Auto-corrección de errores del sistema
- Verificación de compatibilidad del navegador

### 🚨 Protocolo de Emergencia

En caso de fallos durante competencia:

1. **NO cerrar el navegador**
2. **Refrescar página (F5)**
3. Los datos se recuperan automáticamente
4. Si falla, intentar navegador diferente
5. Contactar soporte técnico

### 🎯 Casos de Uso

**Ideal para:**
- 🏟️ Competencias oficiales
- 🥋 Torneos escolares
- 🎪 Eventos sin conexión a internet
- 📱 Ambientes con conectividad limitada
- 🔒 Situaciones que requieren privacidad de datos

### 📊 Puntuación

**Sistema de Puntos:**
- **Victoria**: 2 puntos base + puntos de jueces
- **Empate**: 1 punto base + puntos de jueces  
- **Derrota**: 0 puntos base + puntos de jueces

**Puntos de Jueces:**
- 4 votos de jueces por pelea
- Mayoría determina ganador
- Empate si hay empate 2-2

### 🛠️ Desarrollo

**Versión del Sistema:**
- Base: Sistema Round Robin v2.0
- Portable: v1.0.0
- Fecha: Enero 2025
- Desarrollador: Brian E. Lipnjak

**Cambios en Versión Portable:**
- Eliminación de dependencias externas
- Iconos embebidos con emojis
- Banner de modo offline
- Sistema de backup mejorado
- Documentación completa incluida
- Launcher automático para Windows

### 📞 Soporte

Para soporte técnico o reportes de bugs:
- Desarrollador: Brian E. Lipnjak
- Versión: PORTABLE v1.0.0

---

**🏅 ¡SISTEMA LISTO PARA COMPETENCIAS PROFESIONALES! 🏅**