// TKD Tournament 2026 - BL System
const APP_VERSION = '2026';

// ── Scoring en tiempo real ──────────────────────────────────────────────────
let scoringSocket = null;
let scoringConnected = false;
let scoringMode = 'manual'; // 'manual' | 'live'
let liveScoringLastData = null; // cache del último state:update

const DEFAULT_SCORING_RULES = {
    mode: 'sparring',
    version: 'baseline-itf-1.0',
    judgesCount: 3,
    rounds: { count: 2, duration_seconds: 120, rest_seconds: 30, golden_point: true, overtime_seconds: 60 },
    points: { pts_1: 1, pts_2: 2, pts_3: 3, hand_body: 1, foot_body: 1, foot_head: 2, jump_hand_head: 2, jump_foot_body: 2, jump_foot_head: 3 },
    deductions: { warning_minor: -1, warning_serious: -2, minus_point: -1, disqualify: 'DQ' },
    tiebreak_order: ['fewest_deductions_against', 'golden_point', 'first_clean_point', 'jury_decision'],
    validation: { min_interval_ms_same_judge: 300, require_majority_for_point: false }
};

(function enforceLatestVersion() {
    try {
        const storedVersion = localStorage.getItem('taekwondo_app_version');
        if (storedVersion !== APP_VERSION) {
            const keys = Object.keys(localStorage);
            keys.forEach(key => {
                if (key.startsWith('taekwondo_') && key !== 'taekwondo_app_version') {
                    localStorage.removeItem(key);
                }
            });
            localStorage.setItem('taekwondo_app_version', APP_VERSION);
            console.info(`Actualizando sistema Taekwon-Do a la versión ${APP_VERSION}`);
        }
    } catch (error) {
        console.warn('No fue posible sincronizar la versión de la aplicación.', error);
    }
})();

let tournament; // Variable global para acceso desde HTML

class RoundRobinTournament {
    constructor() {
        this.competitors = [];
        this.fights = [];
        this.currentFightIndex = 0;
        this.judgeDecisions = {};
        this.scoringResultReceived = false;
        this.standings = {};
        this.competitorCount = 5; // Por defecto 5 competidores
        this.brackets = []; // Para sistema de llaves
        this.currentPhase = 'setup'; // setup, groups, final
        this.groupWinners = []; // Ganadores de cada grupo
        
        // Información de categoría
        this.categoryInfo = {
            gender: '',
            ageFrom: '',
            ageTo: '',
            beltCategory: '',
            weightCategory: '',
            fightDuration: 120, // 2 minutos por defecto
            timerWarnings: true
        };
        
        // Cronómetro
        this.timer = {
            seconds: 120,
            originalSeconds: 120,
            isRunning: false,
            intervalId: null,
            isMinimized: false
        };
        
        this.initializeEventListeners();
        this.loadFromLocalStorage(); // Cargar datos guardados
    }

    initializeEventListeners() {
        // Configuración inicial
        document.getElementById('start-tournament').addEventListener('click', () => this.startTournament());
        
        // Selector de número de competidores
        document.getElementById('competitor-count').addEventListener('change', (e) => this.updateCompetitorInputs(e.target.value));
        
        // Botones de jueces
        document.querySelectorAll('.judge-btn').forEach(btn => {
            btn.addEventListener('click', (e) => this.handleJudgeDecision(e));
        });
        
        // Controles de pelea
        document.getElementById('confirm-fight').addEventListener('click', () => this.confirmFight());
        document.getElementById('reset-fight').addEventListener('click', () => this.resetCurrentFight());
        
        // Controles de fase
        document.getElementById('next-phase').addEventListener('click', () => this.nextPhase());
        
        // Modal
        document.getElementById('close-tournament-modal').addEventListener('click', () => this.closeTournamentModal());
        document.getElementById('new-tournament').addEventListener('click', () => this.newTournament());
        
        // Cronómetro
        document.getElementById('timer-start').addEventListener('click', () => this.startTimer());
        document.getElementById('timer-pause').addEventListener('click', () => this.pauseTimer());
        document.getElementById('timer-reset').addEventListener('click', () => this.resetTimer());
        document.getElementById('timer-stop').addEventListener('click', () => this.stopTimer());
        document.getElementById('timer-minimize').addEventListener('click', () => this.toggleTimerMinimize());
        document.getElementById('timer-minutes').addEventListener('change', (e) => this.setTimerDuration(e.target.value));
        
        // Hacer el cronómetro arrastrable
        this.makeTimerDraggable();
        
        // Inicializar controles del cronómetro
        this.initializeTimer();
        document.getElementById('export-results').addEventListener('click', () => this.exportResults());
        
        // Manejo de categoría personalizada
        document.getElementById('belt-category').addEventListener('change', (e) => {
            const customBelt = document.getElementById('custom-belt');
            if (e.target.value === 'Personalizada') {
                customBelt.style.display = 'block';
            } else {
                customBelt.style.display = 'none';
            }
        });
        
        // Inicializar con 5 competidores por defecto
        this.updateCompetitorInputs(5);
    }

    updateCompetitorInputs(count) {
        this.competitorCount = parseInt(count);
        
        // Mostrar/ocultar campos según el número seleccionado
        for (let i = 4; i <= 8; i++) {
            const container = document.getElementById(`competitor${i}-container`);
            const input = document.getElementById(`competitor${i}`);
            
            if (count >= i) {
                container.style.display = 'flex';
                input.required = true;
            } else {
                container.style.display = 'none';
                input.required = false;
                input.value = '';
            }
        }
        
        // Actualizar el texto del botón según el sistema
        let buttonText = '';
        if (count <= 5) {
            const totalFights = (count * (count - 1)) / 2;
            buttonText = `Iniciar Torneo (${totalFights} peleas)`;
        } else if (count == 6) {
            buttonText = 'Iniciar Torneo (2 llaves de 3 + Final)';
        } else if (count == 7) {
            buttonText = 'Iniciar Torneo (1 llave de 4 + 1 llave de 3 + Final)';
        } else if (count == 8) {
            buttonText = 'Iniciar Torneo (2 llaves de 4 + Final)';
        }
        
        document.querySelector('.start-btn').innerHTML = `
            <i class="fas fa-play"></i>
            ${buttonText}
        `;
    }

    startTournament() {
        // Capturar información de categoría
        this.categoryInfo = {
            gender: document.getElementById('gender').value,
            ageFrom: document.getElementById('age-from').value,
            ageTo: document.getElementById('age-to').value,
            beltCategory: document.getElementById('belt-category').value === 'Personalizada' 
                ? document.getElementById('custom-belt-text').value 
                : document.getElementById('belt-category').value,
            weightCategory: document.getElementById('weight-category').value,
            headJudge: document.getElementById('head-judge').value,
            fightDuration: parseInt(document.getElementById('fight-duration').value),
            timerWarnings: document.getElementById('timer-warnings').value === 'true'
        };

        // Configurar cronómetro con el tiempo seleccionado
        this.timer.originalSeconds = this.categoryInfo.fightDuration;
        this.timer.seconds = this.categoryInfo.fightDuration;
        
        // Actualizar selector del cronómetro
        const timerSelect = document.getElementById('timer-minutes');
        timerSelect.value = Math.floor(this.categoryInfo.fightDuration / 60);
        
        this.updateTimerDisplay();

        // Validar información de categoría
        if (!this.categoryInfo.ageFrom || !this.categoryInfo.ageTo) {
            alert('Por favor, completa el rango de edades.');
            return;
        }

        if (parseInt(this.categoryInfo.ageFrom) > parseInt(this.categoryInfo.ageTo)) {
            alert('La edad "desde" no puede ser mayor que la edad "hasta".');
            return;
        }

        if (this.categoryInfo.beltCategory === 'Personalizada' && !document.getElementById('custom-belt-text').value.trim()) {
            alert('Por favor, especifica la categoría personalizada de cinturones.');
            return;
        }

        // Obtener nombres de los competidores según la cantidad seleccionada
        const competitorInputs = [];
        for (let i = 1; i <= this.competitorCount; i++) {
            const input = document.getElementById(`competitor${i}`);
            if (input && input.style.display !== 'none') {
                const value = input.value.trim();
                if (value === '') {
                    alert(`Por favor, ingresa el nombre del competidor ${i}.`);
                    return;
                }
                competitorInputs.push(value);
            }
        }

        // Validar nombres únicos
        const uniqueNames = new Set(competitorInputs);
        if (uniqueNames.size !== competitorInputs.length) {
            alert('Todos los competidores deben tener nombres únicos.');
            return;
        }

        // Inicializar competidores
        this.competitors = competitorInputs.map((name, index) => ({
            id: index + 1,
            name: name,
            fights: 0,
            wins: 0,
            ties: 0,
            losses: 0,
            victoryPoints: 0,
            judgePoints: 0,
            totalPoints: 0,
            bracket: null, // Para identificar a qué llave pertenece
            // Estadísticas específicas de brackets
            bracketFights: 0,
            bracketWins: 0,
            bracketTies: 0,
            bracketLosses: 0,
            bracketVictoryPoints: 0,
            bracketJudgePoints: 0
        }));

        // Decidir el sistema según el número de competidores
        if (this.competitorCount <= 5) {
            // Sistema Round Robin tradicional
            this.currentPhase = 'roundrobin';
            this.generateFightSchedule();
            this.showFightSection();
        } else {
            // Sistema de llaves
            this.currentPhase = 'groups';
            this.createBrackets();
            this.generateGroupStage();
            this.showBracketsSection();
        }
        
        this.initializeStandings();
        this.saveToLocalStorage(); // Guardar estado inicial
        this.loadCurrentFight();
        this.updateStandings();
        this.updateScheduleDisplay();
    }

    generateFightSchedule() {
        this.fights = [];
        
        // Generar todas las combinaciones posibles primero
        const allFights = [];
        for (let i = 0; i < this.competitors.length; i++) {
            for (let j = i + 1; j < this.competitors.length; j++) {
                allFights.push({
                    fighter1Index: i,
                    fighter2Index: j,
                    completed: false,
                    result: null,
                    judgeVotes: {
                        judge1: null,
                        judge2: null,
                        judge3: null,
                        judge4: null
                    }
                });
            }
        }
        
        // Optimizar el orden según el número de competidores
        if (this.competitors.length === 3) {
            this.fights = this.optimizeScheduleFor3Fighters(allFights);
        } else if (this.competitors.length === 4) {
            this.fights = this.optimizeScheduleFor4Fighters(allFights);
        } else {
            this.fights = this.optimizeScheduleGeneral(allFights);
        }
    }

    optimizeScheduleFor3Fighters(fights) {
        // Para 3 luchadores: A vs B, luego el perdedor pelea vs C
        // Esto requiere determinar dinámicamente, por ahora usamos orden básico optimizado
        // Orden: [A vs B], [A vs C], [B vs C] pero se puede reordenar dinámicamente
        return fights; // Se optimizará con lógica dinámica después de cada pelea
    }

    optimizeScheduleFor4Fighters(fights) {
        // Para 4 luchadores: optimizar para evitar peleas consecutivas
        // Orden ideal: [A vs B], [C vs D], [A vs C], [B vs D], [A vs D], [B vs C]
        const optimized = [];
        const fighters = [0, 1, 2, 3];
        
        // Ronda 1: emparejamientos iniciales
        optimized.push(this.findFight(fights, 0, 1)); // A vs B
        optimized.push(this.findFight(fights, 2, 3)); // C vs D
        
        // Ronda 2: cruzar grupos
        optimized.push(this.findFight(fights, 0, 2)); // A vs C
        optimized.push(this.findFight(fights, 1, 3)); // B vs D
        
        // Ronda 3: completar emparejamientos
        optimized.push(this.findFight(fights, 0, 3)); // A vs D
        optimized.push(this.findFight(fights, 1, 2)); // B vs C
        
        return optimized.filter(f => f !== null);
    }

    optimizeScheduleGeneral(fights) {
        // Para 5+ luchadores: algoritmo general para minimizar peleas consecutivas
        const optimized = [];
        const available = [...fights];
        const lastFightTime = {}; // Rastrea cuándo luchó cada competidor por última vez
        
        // Inicializar tiempos
        for (let i = 0; i < this.competitors.length; i++) {
            lastFightTime[i] = -2; // Permitir que todos puedan luchar al principio
        }
        
        while (available.length > 0) {
            let bestFight = null;
            let bestScore = -1;
            let bestIndex = -1;
            
            // Buscar la mejor pelea (la que maximiza el descanso)
            for (let i = 0; i < available.length; i++) {
                const fight = available[i];
                const f1LastFight = lastFightTime[fight.fighter1Index];
                const f2LastFight = lastFightTime[fight.fighter2Index];
                const currentTime = optimized.length;
                
                // Calcular score: cuanto más tiempo desde la última pelea, mejor
                const score = (currentTime - f1LastFight) + (currentTime - f2LastFight);
                
                if (score > bestScore) {
                    bestScore = score;
                    bestFight = fight;
                    bestIndex = i;
                }
            }
            
            // Agregar la mejor pelea y actualizar tiempos
            if (bestFight) {
                optimized.push(bestFight);
                lastFightTime[bestFight.fighter1Index] = optimized.length - 1;
                lastFightTime[bestFight.fighter2Index] = optimized.length - 1;
                available.splice(bestIndex, 1);
            }
        }
        
        return optimized;
    }

    findFight(fights, f1, f2) {
        return fights.find(f => 
            (f.fighter1Index === f1 && f.fighter2Index === f2) ||
            (f.fighter1Index === f2 && f.fighter2Index === f1)
        ) || null;
    }

    // Funciones de optimización específicas para brackets
    optimizeBracketFor3Fighters(fights, bracket) {
        // Para 3 luchadores en bracket: orden optimizado
        // Usar el mismo algoritmo general para consistencia
        return this.optimizeBracketGeneral(fights, bracket);
    }

    optimizeBracketFor4Fighters(fights, bracket) {
        // Para 4 luchadores en bracket: usar la misma lógica optimizada
        // Mapear índices locales del bracket a índices globales
        const localToGlobal = bracket.competitors.map(comp => 
            this.competitors.findIndex(c => c.id === comp.id)
        );
        
        // Crear orden optimizado usando índices locales
        const optimizedOrder = [
            [0, 1], // A vs B
            [2, 3], // C vs D  
            [0, 2], // A vs C
            [1, 3], // B vs D
            [0, 3], // A vs D
            [1, 2]  // B vs C
        ];
        
        const optimized = [];
        optimizedOrder.forEach(([local1, local2]) => {
            const global1 = localToGlobal[local1];
            const global2 = localToGlobal[local2];
            const fight = fights.find(f => 
                (f.fighter1Index === global1 && f.fighter2Index === global2) ||
                (f.fighter1Index === global2 && f.fighter2Index === global1)
            );
            if (fight) optimized.push(fight);
        });
        
        return optimized;
    }

    optimizeBracketGeneral(fights, bracket) {
        // Algoritmo general para cualquier número de competidores en bracket
        const optimized = [];
        const available = [...fights];
        const lastFightTime = {};
        
        // Inicializar tiempos para competidores de este bracket
        bracket.competitors.forEach(comp => {
            const globalIndex = this.competitors.findIndex(c => c.id === comp.id);
            lastFightTime[globalIndex] = -2;
        });
        
        while (available.length > 0) {
            let bestFight = null;
            let bestScore = -1;
            let bestIndex = -1;
            
            for (let i = 0; i < available.length; i++) {
                const fight = available[i];
                const f1LastFight = lastFightTime[fight.fighter1Index] || -2;
                const f2LastFight = lastFightTime[fight.fighter2Index] || -2;
                const currentTime = optimized.length;
                
                const score = (currentTime - f1LastFight) + (currentTime - f2LastFight);
                
                if (score > bestScore) {
                    bestScore = score;
                    bestFight = fight;
                    bestIndex = i;
                }
            }
            
            if (bestFight) {
                optimized.push(bestFight);
                lastFightTime[bestFight.fighter1Index] = optimized.length - 1;
                lastFightTime[bestFight.fighter2Index] = optimized.length - 1;
                available.splice(bestIndex, 1);
            }
        }
        
        return optimized;
    }

    reorderRemainingFightsFor3(completedFight, fighter1, fighter2, votes) {
        // Determinar quién ganó la pelea
        let winnerIndex, loserIndex;
        if (votes.fighter1 > votes.fighter2 && votes.fighter1 > votes.tie) {
            winnerIndex = completedFight.fighter1Index;
            loserIndex = completedFight.fighter2Index;
        } else if (votes.fighter2 > votes.fighter1 && votes.fighter2 > votes.tie) {
            winnerIndex = completedFight.fighter2Index;
            loserIndex = completedFight.fighter1Index;
        } else {
            // En caso de empate, no reordenar
            return;
        }

        // Encontrar al tercer competidor
        const allIndices = [0, 1, 2];
        const fightingIndices = [completedFight.fighter1Index, completedFight.fighter2Index];
        const thirdFighterIndex = allIndices.find(i => !fightingIndices.includes(i));
        
        if (thirdFighterIndex === undefined) return;

        // Obtener peleas restantes (no completadas)
        const remainingFights = this.fights.slice(this.currentFightIndex).filter(f => !f.completed);
        
        if (remainingFights.length === 0) return;

        // Buscar la pelea que incluye al perdedor y al tercer luchador
        const loserVsThirdFight = remainingFights.find(f => 
            (f.fighter1Index === loserIndex && f.fighter2Index === thirdFighterIndex) ||
            (f.fighter1Index === thirdFighterIndex && f.fighter2Index === loserIndex)
        );

        if (loserVsThirdFight) {
            // Mover esta pelea al frente para que el ganador descanse
            const currentIndex = this.fights.indexOf(loserVsThirdFight);
            if (currentIndex > this.currentFightIndex) {
                // Intercambiar con la próxima pelea
                const nextFightIndex = this.currentFightIndex;
                [this.fights[nextFightIndex], this.fights[currentIndex]] = 
                [this.fights[currentIndex], this.fights[nextFightIndex]];
                
                const winner = this.competitors[winnerIndex];
                const loser = this.competitors[loserIndex];
                const third = this.competitors[thirdFighterIndex];
                console.log(`🔄 Reordenando: ${loser.name} peleará próximo vs ${third.name} (${winner.name} descansa)`);
            }
        }
    }

    showTournamentInfo() {
        const tournamentInfo = document.getElementById('tournament-info');
        const categoryDisplay = document.getElementById('category-display');
        
        categoryDisplay.innerHTML = `
            <div class="category-item">
                <h4>Género</h4>
                <span>${this.categoryInfo.gender}</span>
            </div>
            <div class="category-item">
                <h4>Edad</h4>
                <span>${this.categoryInfo.ageFrom} - ${this.categoryInfo.ageTo} años</span>
            </div>
            <div class="category-item">
                <h4>Cinturones</h4>
                <span>${this.categoryInfo.beltCategory}</span>
            </div>
            <div class="category-item">
                <h4>Peso</h4>
                <span>${this.categoryInfo.weightCategory}</span>
            </div>
            <div class="category-item">
                <h4>Jefe de Mesa</h4>
                <span>${this.categoryInfo.headJudge || 'No especificado'}</span>
            </div>
            <div class="category-item">
                <h4>Competidores</h4>
                <span>${this.competitors.length}</span>
            </div>
        `;
        
        tournamentInfo.style.display = 'block';
    }

    // Función estándar para ordenar competidores según reglas oficiales de Taekwon-Do
    sortCompetitorsByRanking(competitors) {
        return [...competitors].sort((a, b) => {
            // 1º CRITERIO: Número de peleas GANADAS
            if (b.wins !== a.wins) {
                return b.wins - a.wins;
            }
            // 2º CRITERIO: Puntos de jueces (solo si empatan en ganadas)
            if (b.judgePoints !== a.judgePoints) {
                return b.judgePoints - a.judgePoints;
            }
            // 3º CRITERIO: Desempates ganados (si los hay)
            const aTiebreakers = a.tiebreakerWins || 0;
            const bTiebreakers = b.tiebreakerWins || 0;
            if (bTiebreakers !== aTiebreakers) {
                return bTiebreakers - aTiebreakers;
            }
            // 4º CRITERIO: Puntos de victoria como último recurso
            if (b.victoryPoints !== a.victoryPoints) {
                return b.victoryPoints - a.victoryPoints;
            }
            // 5º CRITERIO: Orden alfabético
            return a.name.localeCompare(b.name);
        });
    }

    checkForTieAndCreateTiebreaker() {
        // Ordenar competidores usando la función estándar
        const sortedCompetitors = this.sortCompetitorsByRanking(this.competitors);

        // Encontrar empates en cualquier posición (no solo primer lugar)
        if (sortedCompetitors.length >= 2) {
            // Buscar grupos de competidores empatados
            for (let i = 0; i < sortedCompetitors.length - 1; i++) {
                const currentCompetitor = sortedCompetitors[i];
                const tiedGroup = [currentCompetitor];
                
                // Encontrar todos los que están empatados con el actual
                for (let j = i + 1; j < sortedCompetitors.length; j++) {
                    const nextCompetitor = sortedCompetitors[j];
                    // SOLO crear desempate si están empatados en TODOS los criterios de ranking
                    // Usar los MISMOS criterios que sortCompetitorsByRanking
                    if (currentCompetitor.wins === nextCompetitor.wins && 
                        currentCompetitor.judgePoints === nextCompetitor.judgePoints &&
                        (currentCompetitor.tiebreakerWins || 0) === (nextCompetitor.tiebreakerWins || 0) &&
                        currentCompetitor.victoryPoints === nextCompetitor.victoryPoints) {
                        tiedGroup.push(nextCompetitor);
                    } else {
                        break; // Ya no hay más empatados en este grupo
                    }
                }
                
                // Si encontramos un grupo empatado, procesarlo
                if (tiedGroup.length >= 2) {
                    
                    // CASO ESPECIAL: Si TODOS los competidores están empatados, reiniciar torneo
                    if (tiedGroup.length === this.competitors.length) {
                        this.restartEntireTournament();
                        return true;
                    }
                    
                    // CASO NORMAL: Solo 2 empatados - verificar si ya hay desempate resuelto
                    if (tiedGroup.length === 2) {
                        const fighter1 = tiedGroup[0];
                        const fighter2 = tiedGroup[1];
                        
                        // Verificar si ya existe un desempate resuelto con GANADOR entre estos competidores
                        const existingTiebreaker = this.fights.find(fight => 
                            fight.isTiebreaker && 
                            fight.completed &&
                            fight.result && 
                            fight.result.includes('ganó DESEMPATE') && // Debe tener un ganador claro
                            ((fight.fighter1Index === this.competitors.indexOf(fighter1) && 
                              fight.fighter2Index === this.competitors.indexOf(fighter2)) ||
                             (fight.fighter1Index === this.competitors.indexOf(fighter2) && 
                              fight.fighter2Index === this.competitors.indexOf(fighter1)))
                        );
                        
                        if (existingTiebreaker) {
                            // Ya hay un desempate resuelto con ganador entre estos competidores
                            // Verificar quién ganó el desempate para desempatar correctamente
                            const tiebreakerWinner = existingTiebreaker.result.includes(fighter1.name) ? fighter1 : fighter2;
                            console.log(`✅ Desempate ya resuelto: ${tiebreakerWinner.name} ganó. No se crea nuevo desempate.`);
                            // NO crear otro desempate, saltar este grupo
                            i += tiedGroup.length - 1;
                            continue;
                        }
                        
                        // No hay desempate previo, crear nueva pelea de desempate
                        this.createTiebreakerFight(fighter1, fighter2);
                        return true;
                    }
                    
                    // Si hay 3+ empatados en una posición, quedan empatados técnicamente
                    // Saltar este grupo para continuar buscando otros empates
                    i += tiedGroup.length - 1;
                }
            }
        }

        return false; // No hay empate que requiera acción
    }

    restartEntireTournament() {
        alert(`🔄 EMPATE TOTAL\n\n` +
              `TODOS los competidores están empatados con los mismos puntos.\n\n` +
              `Se reiniciará completamente el torneo.\n\n` +
              `Todos los competidores volverán a pelear desde cero.`);

        // Reiniciar estadísticas de todos los competidores
        this.competitors.forEach(competitor => {
            competitor.wins = 0;
            competitor.losses = 0;
            competitor.ties = 0;
            competitor.fights = 0;
            competitor.victoryPoints = 0;
            competitor.judgePoints = 0;
            competitor.tiebreakerWins = 0;
        });

        // Limpiar todas las peleas y recrear el Round Robin original
        this.fights = [];
        this.currentFightIndex = 0;
        this.judgeDecisions = {};

        // Recrear las peleas del Round Robin original
        this.generateFightSchedule();

        // Actualizar displays
        this.updateScheduleDisplay();
        this.saveToLocalStorage();

        // Ocultar el modal de resultados si está abierto
        const resultsModal = document.getElementById('results-modal');
        if (resultsModal && resultsModal.style.display === 'block') {
            resultsModal.style.display = 'none';
        }

        // Mostrar la sección de peleas
        document.getElementById('fight-section').style.display = 'block';

        // Cargar la primera pelea
        this.loadCurrentFight();

        // Actualizar la interfaz después de un breve retraso
        setTimeout(() => {
            this.updateStandings();
            this.updateScheduleDisplay();
        }, 100);
    }

    createTiebreakerFight(fighter1, fighter2, bracketId = null) {
        // Buscar índices de los competidores
        const fighter1Index = this.competitors.findIndex(c => c.id === fighter1.id);
        const fighter2Index = this.competitors.findIndex(c => c.id === fighter2.id);

        // Contar cuántos desempates ya han tenido estos competidores (solo para información)
        const tiebreakerCount = this.fights.filter(f => 
            f.isTiebreaker && 
            ((f.fighter1Index === fighter1Index && f.fighter2Index === fighter2Index) ||
             (f.fighter1Index === fighter2Index && f.fighter2Index === fighter1Index))
        ).length;

        // Crear combate de desempate
        const tiebreakerFight = {
            fighter1Index: fighter1Index,
            fighter2Index: fighter2Index,
            completed: false,
            result: null,
            judgeVotes: {
                judge1: null,
                judge2: null,
                judge3: null,
                judge4: null
            },
            isTiebreaker: true, // Marcar como combate de desempate
            tiebreakerNumber: tiebreakerCount + 1, // Número de desempate
            bracket: bracketId
        };

    // Agregar el combate de desempate
    this.fights.push(tiebreakerFight);
    this.currentFightIndex = this.fights.length - 1;
        
        // No incrementar currentFightIndex, seguirá en el nuevo combate
        // Actualizar displays
        this.updateScheduleDisplay();
        this.saveToLocalStorage();
        
        // Mostrar mensaje de desempate
    const bracketInfo = bracketId ? this.brackets.find(b => b.id === bracketId) : null;
    const bracketLabel = bracketInfo ? ` (${bracketInfo.name})` : '';
    const tiebreakerMsg = tiebreakerCount === 0 ? `COMBATE DE DESEMPATE${bracketLabel}` : `DESEMPATE #${tiebreakerCount + 1}${bracketLabel}`;
    alert(`🥊 ${tiebreakerMsg}\n\n${fighter1.name} vs ${fighter2.name}\n\nAmbos competidores están empatados en:\n• Puntos: ${fighter1.victoryPoints}\n• Jueces: ${fighter1.judgePoints}\n\n¡Se realizará un combate${tiebreakerCount > 0 ? ' adicional' : ''} para determinar el ganador!`);
        
        // Cargar el combate de desempate
        this.loadCurrentFight();
    }

    handleTiebreakerResult(currentFight, fighter1, fighter2, votes, decisions) {
        // En combate de desempate, NO se actualizan peleas/victorias/empates normales
        // Solo se determina el ganador por jueces usando la MISMA LÓGICA que combates normales
        
        let hasWinner = false;
        let tiebreakerWinner = null;

        // Determinar resultado - SIEMPRE GANA MAYORÍA DE VOTOS
        if (votes.tie > votes.fighter1 && votes.tie > votes.fighter2) {
            // EMPATE tiene mayoría de votos
            currentFight.result = 'EMPATE - Se requiere nuevo desempate';
        } else if (votes.fighter1 > votes.fighter2 && votes.fighter1 > votes.tie) {
            // Fighter 1 tiene mayoría de votos
            currentFight.result = `${fighter1.name} ganó DESEMPATE`;
            fighter1.tiebreakerWins = (fighter1.tiebreakerWins || 0) + 1;
            hasWinner = true;
            tiebreakerWinner = fighter1;
        } else if (votes.fighter2 > votes.fighter1 && votes.fighter2 > votes.tie) {
            // Fighter 2 tiene mayoría de votos
            currentFight.result = `${fighter2.name} ganó DESEMPATE`;
            fighter2.tiebreakerWins = (fighter2.tiebreakerWins || 0) + 1;
            hasWinner = true;
            tiebreakerWinner = fighter2;
        } else if (votes.fighter1 === votes.fighter2 && votes.fighter1 > votes.tie) {
            // Fighter1 y Fighter2 empatan en votos pero ambos superan a empate - gana fighter1 por criterio
            currentFight.result = `${fighter1.name} ganó DESEMPATE`;
            fighter1.tiebreakerWins = (fighter1.tiebreakerWins || 0) + 1;
            hasWinner = true;
            tiebreakerWinner = fighter1;
        } else if (votes.fighter1 === votes.tie && votes.fighter1 > votes.fighter2) {
            // Fighter1 y empate empatan en votos pero ambos superan a fighter2 - gana fighter1 por criterio
            currentFight.result = `${fighter1.name} ganó DESEMPATE`;
            fighter1.tiebreakerWins = (fighter1.tiebreakerWins || 0) + 1;
            hasWinner = true;
            tiebreakerWinner = fighter1;
        } else if (votes.fighter2 === votes.tie && votes.fighter2 > votes.fighter1) {
            // Fighter2 y empate empatan en votos pero ambos superan a fighter1 - gana fighter2 por criterio
            currentFight.result = `${fighter2.name} ganó DESEMPATE`;
            fighter2.tiebreakerWins = (fighter2.tiebreakerWins || 0) + 1;
            hasWinner = true;
            tiebreakerWinner = fighter2;
        } else {
            // Empate total (todos tienen mismos votos) o cualquier otro caso no contemplado
            currentFight.result = 'EMPATE - Se requiere nuevo desempate';
        }
        
        // Si no hay ganador, crear otro desempate
        if (!hasWinner) {
            // Marcar como completada pero crear otro desempate
            currentFight.completed = true;
            currentFight.completedAt = new Date();
            currentFight.judgeVotes = { ...decisions };
            
            // Avanzar índice y crear nuevo desempate
            this.currentFightIndex++;
            this.updateStandings();
            this.updateFightHistory();
            this.updateScheduleDisplay();
            this.saveToLocalStorage();
            
            alert(`⚡ NUEVO EMPATE\n\n${fighter1.name} y ${fighter2.name} volvieron a empatar en el desempate.\n\nVotos: ${fighter1.name}: ${votes.fighter1}, ${fighter2.name}: ${votes.fighter2}, Empates: ${votes.tie}\n\n¡Se realizará un nuevo combate de desempate!`);
            
            // Crear otro combate de desempate
            this.createTiebreakerFight(fighter1, fighter2);
            return;
        }
        
        // Si hay ganador definido, finalizar
        // Marcar pelea como completada
        currentFight.completed = true;
        currentFight.completedAt = new Date();
        currentFight.judgeVotes = { ...decisions };

        // Avanzar a siguiente pelea
        this.currentFightIndex++;
        this.updateStandings();
        this.updateFightHistory();
        this.updateScheduleDisplay();
        this.saveToLocalStorage();
        
        // Mostrar mensaje de ganador del desempate
        const winner = tiebreakerWinner ? tiebreakerWinner.name : (currentFight.result.includes(fighter1.name) ? fighter1.name : fighter2.name);
        
        // IMPORTANTE: Verificar si es sistema de brackets vs Round Robin
        if (this.competitorCount > 5 && currentFight.bracket) {
            // Es un desempate de bracket - puede continuar con otras llaves
            console.log(`🎯 DESEMPATE DE BRACKET RESUELTO - Llave ${currentFight.bracket}, Ganador: ${winner}`);
            alert(`🏆 ¡DESEMPATE RESUELTO!\n\nGanador: ${winner}\n\nVotos: ${fighter1.name}: ${votes.fighter1}, ${fighter2.name}: ${votes.fighter2}, Empates: ${votes.tie}\n\nContinuando con las peleas restantes...`);
            
            // Resolver la llave después del desempate
            this.resolveBracketIfComplete(currentFight.bracket);
            
            // Actualizar display de brackets
            this.updateBracketsDisplay();
            
            // Buscar automáticamente la siguiente pelea disponible
            this.findNextAvailableFight();
        } else {
            // Es Round Robin tradicional - la categoría puede haber terminado
            console.log(`🏁 DESEMPATE DE ROUND ROBIN RESUELTO - Ganador: ${winner}`);
            alert(`🏆 ¡DESEMPATE RESUELTO!\n\nGanador: ${winner}\n\nVotos: ${fighter1.name}: ${votes.fighter1}, ${fighter2.name}: ${votes.fighter2}, Empates: ${votes.tie}\n\nLa categoría ha terminado.`);
        }
        
        this.loadCurrentFight();
    }

    loadCurrentFight() {
        console.log('loadCurrentFight - currentFightIndex:', this.currentFightIndex, 'fights.length:', this.fights.length);
        console.log('Peleas disponibles:', this.fights.map((f, index) => ({
            index: index,
            completed: f.completed, 
            bracket: f.bracket,
            fighters: f.fighter1Index !== undefined ? `${this.competitors[f.fighter1Index]?.name} vs ${this.competitors[f.fighter2Index]?.name}` : 'N/A',
            isFinal: f.isFinal
        })));
        
        if (this.currentFightIndex >= this.fights.length) {
            console.log('📈 currentFightIndex >= fights.length - Buscando peleas pendientes...');
            
            // PRIMERO: Buscar si hay peleas no completadas en cualquier llave
            const incompleteFight = this.fights.find(fight => !fight.completed);
            if (incompleteFight) {
                const newIndex = this.fights.indexOf(incompleteFight);
                console.log(`🔄 Encontrada pelea pendiente en índice ${newIndex}, llave ${incompleteFight.bracket}`);
                this.currentFightIndex = newIndex;
                this.loadCurrentFight();
                return;
            }
            
            // Para sistema de llaves (6-8 competidores), verificar si se puede generar pelea final
            if (this.competitorCount > 5 && this.currentPhase === 'groups') {
                console.log('🏗️ Verificando si todas las llaves están completas para generar final...');
                // Verificar si todas las llaves están completas y generar final automáticamente
                if (this.checkAndGenerateFinalIfReady()) {
                    return; // Se generó la pelea final, continuar
                }
            }
            
            // Solo verificar empates para Round Robin, no para sistema de brackets
            if (this.competitorCount <= 5) {
                // Verificar si hay empate y necesita desempate
                if (this.checkForTieAndCreateTiebreaker()) {
                    return; // Se creó un combate de desempate, continuar
                }
            }
            
            // Categoría completada sin empates
            this.showTournamentResults();
            return;
        }

        const currentFight = this.fights[this.currentFightIndex];
        console.log('Pelea actual (índice ' + this.currentFightIndex + '):', currentFight);
        
        if (currentFight.completed) {
            console.log('La pelea actual ya está completada, avanzando...');
            this.currentFightIndex++;
            this.loadCurrentFight();
            return;
        }
        
        const fighter1 = this.competitors[currentFight.fighter1Index];
        const fighter2 = this.competitors[currentFight.fighter2Index];

        // Actualizar información de la pelea
        let fightInfo = `Pelea ${this.currentFightIndex + 1} de ${this.fights.length}`;
        if (currentFight.isFinal) {
            fightInfo = `🏆 FINAL - ${fightInfo}`;
        } else if (currentFight.bracket) {
            const bracketName = this.brackets.find(b => b.id === currentFight.bracket)?.name || '';
            fightInfo = `${bracketName} - ${fightInfo}`;
        }
        
        document.getElementById('current-fight-info').textContent = fightInfo;
        document.getElementById('fighter1-name').textContent = fighter1.name;
        document.getElementById('fighter2-name').textContent = fighter2.name;

        // Actualizar nombres en botones de jueces
        document.querySelectorAll('#fighter1-name-j1, #fighter1-name-j2, #fighter1-name-j3, #fighter1-name-j4')
            .forEach(el => el.textContent = fighter1.name);
        document.querySelectorAll('#fighter2-name-j1, #fighter2-name-j2, #fighter2-name-j3, #fighter2-name-j4')
            .forEach(el => el.textContent = fighter2.name);

        // Actualizar header
        document.getElementById('fight-display').textContent = fightInfo;
        document.getElementById('competitors-display').textContent = `${fighter1.name} vs ${fighter2.name}`;

        // Actualizar nombres en el sistema de penalizaciones
        this.updateCompetitorNames(fighter1.name, fighter2.name);

        // ── Scoring en tiempo real ──────────────────────────────────────
        this.scoringResultReceived = false;
        updateScoringPanelNames(fighter1.name, fighter2.name);
        if (scoringMode === 'live' && scoringConnected) {
            const rules = Object.assign({}, DEFAULT_SCORING_RULES, {
                rounds: Object.assign({}, DEFAULT_SCORING_RULES.rounds, {
                    duration_seconds: (this.categoryInfo && this.categoryInfo.fightDuration) || 120
                })
            });
            scoringSocket.emit('match:load', {
                rules,
                match: {
                    id: 'fight-' + this.currentFightIndex,
                    ringId: 'ring-1',
                    red:  { id: String(fighter1.id), name: fighter1.name },
                    blue: { id: String(fighter2.id), name: fighter2.name }
                }
            });
        }
        // ─────────────────────────────────────────────────────────────────

        // Reset de decisiones de jueces
        this.resetJudgeDecisions();
        this.updateFightResult();
    }

    setWinnerFromScoring(winner, redScore, blueScore) {
        if (this.scoringResultReceived || scoringMode !== 'live') return;
        this.scoringResultReceived = true;

        const vote = winner === 'red' ? '1' : winner === 'blue' ? '2' : 'tie';
        this.judgeDecisions = { judge1: vote, judge2: vote, judge3: vote, judge4: vote };
        this._liveFightScores = { red: redScore || 0, blue: blueScore || 0 };

        const confirmBtn = document.getElementById('confirm-fight');
        if (confirmBtn) confirmBtn.disabled = false;
        this.updateFightResult();

        setTimeout(() => {
            if (this.scoringResultReceived) this.confirmFight();
        }, 1500);
    }

    handleJudgeDecision(event) {
        const button = event.target.closest('.judge-btn');
        const judgeNumber = button.dataset.judge;
        const fighterChoice = button.dataset.fighter;

        // Remover selección anterior del mismo juez
        const judgeButtons = document.querySelectorAll(`[data-judge="${judgeNumber}"]`);
        judgeButtons.forEach(btn => btn.classList.remove('selected'));

        // Agregar selección actual
        button.classList.add('selected');

        // Guardar decisión
        this.judgeDecisions[`judge${judgeNumber}`] = fighterChoice;

        // Actualizar display de selección
        const selectionElement = document.getElementById(`judge${judgeNumber}-selection`);
        if (fighterChoice === 'tie') {
            selectionElement.textContent = 'Empate';
        } else {
            const currentFight = this.fights[this.currentFightIndex];
            const fighterIndex = fighterChoice === '1' ? currentFight.fighter1Index : currentFight.fighter2Index;
            selectionElement.textContent = this.competitors[fighterIndex].name;
        }

        this.updateFightResult();
    }

    updateFightResult() {
        const decisions = Object.values(this.judgeDecisions);
        
        // Verificar si todos los jueces han decidido
        if (decisions.length < 4 || decisions.some(decision => decision === null)) {
            document.getElementById('fight-winner').textContent = '-';
            document.getElementById('victory-points').textContent = '-';
            document.getElementById('judge-points').textContent = '-';
            document.getElementById('confirm-fight').disabled = true;
            return;
        }

        // Contar votos
        const votes = {
            fighter1: 0,
            fighter2: 0,
            tie: 0
        };

        Object.values(this.judgeDecisions).forEach(decision => {
            if (decision === '1') votes.fighter1++;
            else if (decision === '2') votes.fighter2++;
            else if (decision === 'tie') votes.tie++;
        });

        const currentFight = this.fights[this.currentFightIndex];
        const fighter1 = this.competitors[currentFight.fighter1Index];
        const fighter2 = this.competitors[currentFight.fighter2Index];

        let winner, victoryPoints, judgePoints;

        // VERIFICAR SI ES PELEA FINAL - NO PUEDE HABER EMPATES
        const isFinale = this.isFinalFight(currentFight);
        
        // Determinar resultado - SIEMPRE GANA MAYORÍA DE VOTOS
        if (votes.tie > votes.fighter1 && votes.tie > votes.fighter2) {
            // EMPATE tiene mayoría de votos
            if (isFinale) {
                // Es pelea final pero jueces vieron empate - PERMITIR pero crear nueva pelea
                winner = '⚡ EMPATE - Nueva pelea requerida';
                victoryPoints = 'Los competidores deberán pelear nuevamente';
                judgePoints = `Votos: ${fighter1.name}: ${votes.fighter1}, ${fighter2.name}: ${votes.fighter2}, Empates: ${votes.tie}`;
            } else {
                // Empate normal en ronda clasificatoria
                winner = 'Empate';
                victoryPoints = `${fighter1.name}: 1 pt, ${fighter2.name}: 1 pt`;
                judgePoints = `${fighter1.name}: +${votes.fighter1} pts, ${fighter2.name}: +${votes.fighter2} pts`;
            }
        } else if (votes.fighter1 > votes.fighter2 && votes.fighter1 > votes.tie) {
            // Fighter 1 tiene mayoría de votos
            winner = `${fighter1.name} (Ganador)`;
            victoryPoints = `${fighter1.name}: 3 pts, ${fighter2.name}: 0 pts`;
            judgePoints = `${fighter1.name}: +${votes.fighter1} pts, ${fighter2.name}: +${votes.fighter2} pts`;
        } else if (votes.fighter2 > votes.fighter1 && votes.fighter2 > votes.tie) {
            // Fighter 2 tiene mayoría de votos
            winner = `${fighter2.name} (Ganador)`;
            victoryPoints = `${fighter2.name}: 3 pts, ${fighter1.name}: 0 pts`;
            judgePoints = `${fighter2.name}: +${votes.fighter2} pts, ${fighter1.name}: +${votes.fighter1} pts`;
        } else if (votes.fighter1 === votes.fighter2 && votes.fighter1 > votes.tie) {
            // Fighter1 y Fighter2 empatan en votos - DEBE SER EMPATE
            if (isFinale) {
                // Es pelea final pero empate - PERMITIR pero crear nueva pelea
                winner = '⚡ EMPATE - Nueva pelea requerida';
                victoryPoints = 'Los competidores deberán pelear nuevamente';
                judgePoints = `Votos: ${fighter1.name}: ${votes.fighter1}, ${fighter2.name}: ${votes.fighter2}, Empates: ${votes.tie}`;
            } else {
                // Empate normal en ronda clasificatoria
                winner = 'Empate';
                victoryPoints = `${fighter1.name}: 1 pt, ${fighter2.name}: 1 pt`;
                judgePoints = `${fighter1.name}: +${votes.fighter1} pts, ${fighter2.name}: +${votes.fighter2} pts`;
            }
        } else if (votes.fighter1 === votes.tie && votes.fighter1 > votes.fighter2) {
            // Fighter1 y empate empatan en votos pero ambos superan a fighter2 - gana fighter1 por criterio
            winner = `${fighter1.name} (Ganador)`;
            victoryPoints = `${fighter1.name}: 3 pts, ${fighter2.name}: 0 pts`;
            judgePoints = `${fighter1.name}: +${votes.fighter1} pts, ${fighter2.name}: +${votes.fighter2} pts`;
        } else if (votes.fighter2 === votes.tie && votes.fighter2 > votes.fighter1) {
            // Fighter2 y empate empatan en votos pero ambos superan a fighter1 - gana fighter2 por criterio
            winner = `${fighter2.name} (Ganador)`;
            victoryPoints = `${fighter2.name}: 3 pts, ${fighter1.name}: 0 pts`;
            judgePoints = `${fighter2.name}: +${votes.fighter2} pts, ${fighter1.name}: +${votes.fighter1} pts`;
        } else {
            // Empate total (todos tienen mismos votos) o cualquier otro caso no contemplado
            if (isFinale) {
                // Es pelea final pero empate total - PERMITIR pero crear nueva pelea
                winner = '⚡ EMPATE - Nueva pelea requerida';
                victoryPoints = 'Los competidores deberán pelear nuevamente';
                judgePoints = `Votos: ${fighter1.name}: ${votes.fighter1}, ${fighter2.name}: ${votes.fighter2}, Empates: ${votes.tie}`;
            } else {
                // Empate normal en ronda clasificatoria
                winner = 'Empate';
                victoryPoints = `${fighter1.name}: 1 pt, ${fighter2.name}: 1 pt`;
                judgePoints = `${fighter1.name}: +${votes.fighter1} pts, ${fighter2.name}: +${votes.fighter2} pts`;
            }
        }

        document.getElementById('fight-winner').textContent = winner;
        document.getElementById('victory-points').textContent = victoryPoints;
        document.getElementById('judge-points').textContent = judgePoints;
        document.getElementById('confirm-fight').disabled = false;
    }

    // Detectar si es una pelea final que NO puede empatar
    isFinalFight(fight) {
        // 1. Si es fase final del sistema de brackets (6-8 competidores)
        // SOLO la pelea final entre ganadores de llave
        if (this.currentPhase === 'final') {
            return true;
        }
        
        // 2. Si es pelea de desempate (para determinar ganador de llave)
        if (fight.isTiebreaker) {
            return true;
        }
        
        // 3. Las peleas normales de llave SÍ pueden empatar
        // (Todos contra todos dentro de cada llave permite empates)
        
        return false;
    }

    confirmFight() {
        const currentFight = this.fights[this.currentFightIndex];
        const decisions = { ...this.judgeDecisions };
        const fighter1 = this.competitors[currentFight.fighter1Index];
        const fighter2 = this.competitors[currentFight.fighter2Index];

        // Contar votos
        const votes = {
            fighter1: 0,
            fighter2: 0,
            tie: 0
        };

        Object.values(decisions).forEach(decision => {
            if (decision === '1') votes.fighter1++;
            else if (decision === '2') votes.fighter2++;
            else if (decision === 'tie') votes.tie++;
        });

        // LÓGICA ESPECIAL PARA COMBATES DE DESEMPATE
        if (currentFight.isTiebreaker) {
            this.handleTiebreakerResult(currentFight, fighter1, fighter2, votes, decisions);
            return;
        }

        // Actualizar estadísticas de competidores (COMBATE NORMAL)
        fighter1.fights++;
        fighter2.fights++;

        // Asignar puntos de victoria/empate - SIEMPRE GANA MAYORÍA DE VOTOS
        if (votes.tie > votes.fighter1 && votes.tie > votes.fighter2) {
            // EMPATE tiene mayoría de votos
            fighter1.ties++;
            fighter2.ties++;
            fighter1.victoryPoints += 1;
            fighter2.victoryPoints += 1;
            currentFight.result = 'Empate';
        } else if (votes.fighter1 > votes.fighter2 && votes.fighter1 > votes.tie) {
            // Fighter 1 tiene mayoría de votos
            fighter1.wins++;
            fighter1.victoryPoints += 3;
            fighter2.losses++;
            currentFight.result = `${fighter1.name} ganó`;
        } else if (votes.fighter2 > votes.fighter1 && votes.fighter2 > votes.tie) {
            // Fighter 2 tiene mayoría de votos
            fighter2.wins++;
            fighter2.victoryPoints += 3;
            fighter1.losses++;
            currentFight.result = `${fighter2.name} ganó`;
        } else if (votes.fighter1 === votes.fighter2 && votes.fighter1 > votes.tie) {
            // Fighter1 y Fighter2 empatan en votos pero ambos superan a empate - gana fighter1 por criterio
            fighter1.wins++;
            fighter1.victoryPoints += 3;
            fighter2.losses++;
            currentFight.result = `${fighter1.name} ganó`;
        } else if (votes.fighter1 === votes.tie && votes.fighter1 > votes.fighter2) {
            // Fighter1 y empate empatan en votos pero ambos superan a fighter2 - gana fighter1 por criterio
            fighter1.wins++;
            fighter1.victoryPoints += 3;
            fighter2.losses++;
            currentFight.result = `${fighter1.name} ganó`;
        } else if (votes.fighter2 === votes.tie && votes.fighter2 > votes.fighter1) {
            // Fighter2 y empate empatan en votos pero ambos superan a fighter1 - gana fighter2 por criterio
            fighter2.wins++;
            fighter2.victoryPoints += 3;
            fighter1.losses++;
            currentFight.result = `${fighter2.name} ganó`;
        } else {
            // Empate total (todos tienen mismos votos) o cualquier otro caso no contemplado
            fighter1.ties++;
            fighter2.ties++;
            fighter1.victoryPoints += 1;
            fighter2.victoryPoints += 1;
            currentFight.result = 'Empate';
        }

        // Asignar puntos de jueces (SEPARADOS de los puntos de victoria)
        if (this._liveFightScores) {
            // En modo live usar puntajes reales del scoring engine
            fighter1.judgePoints += this._liveFightScores.red;
            fighter2.judgePoints += this._liveFightScores.blue;
            this._liveFightScores = null;
        } else {
            fighter1.judgePoints += votes.fighter1;
            fighter2.judgePoints += votes.fighter2;
        }

        // Los puntos totales ya NO se usan - solo victorias y jueces por separado

        // Marcar pelea como completada con fecha y hora
        currentFight.completed = true;
        currentFight.completedAt = new Date(); // Agregar timestamp
        currentFight.judgeVotes = { ...decisions };

        // VERIFICAR SI ES PELEA FINAL CON EMPATE - Crear nueva pelea automáticamente
        const isFinale = this.isFinalFight(currentFight);
        const isDrawResult = currentFight.result === 'Empate';
        
        if (isFinale && isDrawResult) {
            // Es pelea final y terminó en empate - crear nueva pelea
            alert(`⚡ EMPATE EN PELEA FINAL\n\n` +
                  `${fighter1.name} vs ${fighter2.name} empataron.\n\n` +
                  `Se creará automáticamente una nueva pelea entre los mismos competidores.\n\n` +
                  `Esta nueva pelea será la definitiva para determinar el ganador.`);
            
            // Crear nueva pelea entre los mismos competidores
            const newFight = {
                fighter1Index: currentFight.fighter1Index,
                fighter2Index: currentFight.fighter2Index,
                fighter1Name: fighter1.name,
                fighter2Name: fighter2.name,
                completed: false,
                result: null,
                isTiebreaker: true, // Marcar como pelea de desempate
                isFinal: currentFight.isFinal || false,
                bracket: currentFight.bracket || null
            };
            
            // Agregar la nueva pelea
            this.fights.push(newFight);
            
            // No avanzar el índice, se queda en la nueva pelea
            this.currentFightIndex = this.fights.length - 1;
            
            // Actualizar displays
            this.updateStandings();
            this.updateFightHistory();
            this.updateScheduleDisplay();
            this.saveToLocalStorage();
            this.createBackupCopy();
            
            // Cargar la nueva pelea
            this.loadCurrentFight();
            return;
        }

        // Avanzar a siguiente pelea
        this.currentFightIndex++;

        // Buscar siguiente pelea pendiente priorizando combates posteriores, si no hay, la primera pendiente
        const forwardPendingIndex = this.fights.findIndex((fight, index) => index >= this.currentFightIndex && !fight.completed);
        if (forwardPendingIndex !== -1) {
            this.currentFightIndex = forwardPendingIndex;
        } else {
            const anyPendingIndex = this.fights.findIndex(fight => !fight.completed);
            if (anyPendingIndex !== -1) {
                this.currentFightIndex = anyPendingIndex;
                console.log(`Saltando a pelea pendiente encontrada en índice ${this.currentFightIndex}`);
            } else {
                console.log('No se encontraron más peleas pendientes');
            }
        }
        
        // Para categorías de 3, reordenar dinámicamente para que el ganador descanse
        if (this.competitors.length === 3 && this.currentFightIndex < this.fights.length) {
            this.reorderRemainingFightsFor3(currentFight, fighter1, fighter2, votes);
        }
        
        // Actualizar displays
    this.updateStandings();
    this.updateFightHistory();
    this.updateScheduleDisplay();
        
        // Si es sistema de llaves, actualizar brackets
        if (this.competitorCount > 5) {
            console.log(`🏗️ Sistema de llaves activo - Procesando pelea de llave ${currentFight.bracket}`);
            
            if (this.currentPhase === 'groups') {
                this.updateBracketStatistics();
                
                // Resolver la llave de la pelea actual si está completada
                if (currentFight.bracket) {
                    this.resolveBracketIfComplete(currentFight.bracket);
                }
                
                // IMPORTANTE: Después de resolver una llave, buscar automáticamente la siguiente pelea disponible
                this.findNextAvailableFight();
            }

            this.updateBracketsDisplay();

            // Verificar si se completó la fase de grupos DESPUÉS de buscar próxima pelea
            if (this.currentPhase === 'groups' && this.checkGroupStageComplete()) {
                // Intentar generar final automáticamente
                if (this.checkAndGenerateFinalIfReady()) {
                    return; // Se generó la final, salir
                } else {
                    document.getElementById('current-phase').textContent = 'Fase de Grupos Completada';
                    document.getElementById('next-phase').style.display = 'block';
                }
            }
        }
        
        this.saveToLocalStorage(); // Auto-guardar progreso
        this.createBackupCopy(); // Backup adicional

        // Cargar siguiente pelea
        this.loadCurrentFight();
    }

    resetCurrentFight() {
        this.resetJudgeDecisions();
        this.updateFightResult();
    }

    resetJudgeDecisions() {
        this.judgeDecisions = {};
        
        // Remover todas las selecciones
        document.querySelectorAll('.judge-btn').forEach(btn => {
            btn.classList.remove('selected');
        });
        
        // Reset de displays de selección
        for (let i = 1; i <= 4; i++) {
            document.getElementById(`judge${i}-selection`).textContent = 'Sin decisión';
        }
        
        // Reset de penalizaciones
        this.resetPenalties();
    }

    initializeStandings() {
        this.updateStandings();
    }

    updateStandings() {
        const tbody = document.getElementById('standings-body');
        tbody.innerHTML = '';

        // Si es sistema de brackets y estamos en fase de grupos, no mostrar tabla general
        if (this.competitorCount > 5 && this.currentPhase === 'groups') {
            // En fase de grupos de brackets, no mostrar tabla de posiciones general
            tbody.innerHTML = `
                <tr>
                    <td colspan="8" style="text-align: center; padding: 20px; color: #666;">
                        <strong>Fase de Grupos en Progreso</strong><br>
                        Las posiciones se mostrarán al completar todas las peleas de los brackets
                    </td>
                </tr>
            `;
            return;
        }

        // Para Round Robin o después de completar fase de grupos
        // Ordenar competidores: PRIMERO por victorias, en empate por jueces, luego desempates ganados
        const sortedCompetitors = [...this.competitors].sort((a, b) => {
            // Primero: El que tiene más victorias (combates ganados)
            if (b.victoryPoints !== a.victoryPoints) {
                return b.victoryPoints - a.victoryPoints;
            }
            // En caso de empate en victorias: Gana el que tuvo más jueces
            if (b.judgePoints !== a.judgePoints) {
                return b.judgePoints - a.judgePoints;
            }
            // En caso de empate total: Gana el que tiene desempates ganados
            const aTiebreakers = a.tiebreakerWins || 0;
            const bTiebreakers = b.tiebreakerWins || 0;
            if (bTiebreakers !== aTiebreakers) {
                return bTiebreakers - aTiebreakers;
            }
            // Si persiste empate total, mantener orden alfabético
            return a.name.localeCompare(b.name);
        });

        // Detectar empates técnicos para mostrar posiciones correctas
        let currentPosition = 1;
        let displayPosition = 1;
        
        sortedCompetitors.forEach((competitor, index) => {
            // Verificar si está empatado con el anterior
            let isNewGroup = false;
            if (index === 0) {
                isNewGroup = true;
            } else {
                const prev = sortedCompetitors[index - 1];
                if (competitor.victoryPoints !== prev.victoryPoints || 
                    competitor.judgePoints !== prev.judgePoints) {
                    isNewGroup = true;
                    currentPosition = index + 1;
                }
            }
            
            if (isNewGroup) {
                displayPosition = currentPosition;
            }
            
            // Verificar cuántos están empatados en este grupo
            let tiedCount = 1;
            for (let j = index + 1; j < sortedCompetitors.length; j++) {
                const next = sortedCompetitors[j];
                if (competitor.victoryPoints === next.victoryPoints && 
                    competitor.judgePoints === next.judgePoints) {
                    tiedCount++;
                } else {
                    break;
                }
            }
            
            // Determinar cómo mostrar la posición
            let positionText;
            if (tiedCount > 1) {
                // Empate técnico
                const endPosition = displayPosition + tiedCount - 1;
                positionText = `${displayPosition}°-${endPosition}° (Empate)`;
            } else {
                positionText = `${displayPosition}°`;
            }

            const row = tbody.insertRow();
            row.innerHTML = `
                <td><strong style="color: ${tiedCount > 1 ? '#f39c12' : '#2c3e50'};">${positionText}</strong></td>
                <td>${competitor.name}</td>
                <td>${competitor.fights}</td>
                <td>${competitor.wins}</td>
                <td>${competitor.ties}</td>
                <td>${competitor.losses}</td>
                <td><strong style="color: #1e6837; font-size: 1.2em; font-weight: 900;">${competitor.victoryPoints}</strong></td>
                <td><strong style="color: #b71c1c; font-size: 1.2em; font-weight: 900;">${competitor.judgePoints}</strong></td>
            `;
        });
    }

    updateFightHistory() {
        const historyList = document.getElementById('fights-list');
        historyList.innerHTML = '';

        this.fights.forEach((fight, index) => {
            if (fight.completed) {
                const fighter1 = this.competitors[fight.fighter1Index];
                const fighter2 = this.competitors[fight.fighter2Index];
                
                // Formatear fecha y hora
                const completedDate = fight.completedAt || new Date();
                const dateStr = completedDate.toLocaleDateString('es-ES');
                const timeStr = completedDate.toLocaleTimeString('es-ES', { 
                    hour: '2-digit', 
                    minute: '2-digit' 
                });
                
                const fightItem = document.createElement('div');
                fightItem.className = `fight-item completed ${fight.isTiebreaker ? 'tiebreaker' : ''}`;
                
                const fightLabel = fight.isTiebreaker ? '⚡ DESEMPATE' : `Pelea ${index + 1}`;
                
                fightItem.innerHTML = `
                    <div class="fight-details">
                        <div class="fight-competitors">${fighter1.name} vs ${fighter2.name}</div>
                        <div class="fight-result">Resultado: ${fight.result}</div>
                        <div class="fight-datetime">📅 ${dateStr} - 🕐 ${timeStr}</div>
                    </div>
                    <div class="fight-number ${fight.isTiebreaker ? 'tiebreaker-label' : ''}">${fightLabel}</div>
                `;
                historyList.appendChild(fightItem);
            }
        });
    }

    updateScheduleDisplay() {
        const scheduleList = document.getElementById('schedule-list');
        scheduleList.innerHTML = '';

        this.fights.forEach((fight, index) => {
            const fighter1 = this.competitors[fight.fighter1Index];
            const fighter2 = this.competitors[fight.fighter2Index];
            
            const scheduleItem = document.createElement('div');
            scheduleItem.className = `schedule-item ${fight.completed ? 'completed' : 'pending'}`;
            
            let statusText = fight.completed ? `✓ ${fight.result}` : 
                            index === this.currentFightIndex ? '🔴 En progreso' : '⏳ Pendiente';
            
            scheduleItem.innerHTML = `
                <div class="fight-details">
                    <div class="fight-competitors">${fighter1.name} vs ${fighter2.name}</div>
                    <div class="fight-result">${statusText}</div>
                </div>
                <div class="fight-number">Pelea ${index + 1}</div>
            `;
            scheduleList.appendChild(scheduleItem);
        });
    }

    showTournamentResults() {
        document.getElementById('fight-section').style.display = 'none';
        
        // Actualizar standings finales en el modal
        const finalStandings = document.getElementById('final-standings');
        
        if (this.competitorCount > 5) {
            // Sistema de llaves - buscar ganador de la final
            console.log('🏆 RESULTADOS TORNEO - Iniciando análisis de final...');
            
            // APLICAR AUTO-CORRECCIÓN EN RESULTADOS TAMBIÉN
            let finalFight = this.fights.find(f => f.isFinal && f.completed);
            
            if (!finalFight && this.groupWinners.length === 2) {
                console.log('⚠️ RESULTADOS: No se encuentra final marcada, aplicando auto-corrección...');
                const winner1Index = this.competitors.findIndex(c => c.id === this.groupWinners[0]);
                const winner2Index = this.competitors.findIndex(c => c.id === this.groupWinners[1]);
                
                // Buscar TODAS las peleas entre ganadores (incluye desempates)
                const fightsBetweenWinners = this.fights.filter(f => 
                    f.completed &&
                    ((f.fighter1Index === winner1Index && f.fighter2Index === winner2Index) ||
                     (f.fighter1Index === winner2Index && f.fighter2Index === winner1Index))
                );
                
                if (fightsBetweenWinners.length > 0) {
                    // Usar la última pelea (puede ser un desempate)
                    const existingFight = fightsBetweenWinners[fightsBetweenWinners.length - 1];
                    console.log('✅ RESULTADOS: Encontrada pelea entre ganadores, marcando como final');
                    existingFight.isFinal = true;
                    finalFight = existingFight;
                }
            }
            
            let championMessage = '';
            
            if (finalFight) {
                // Determinar ganador de la final
                const votes = {
                    fighter1: 0,
                    fighter2: 0,
                    tie: 0
                };
                
                Object.values(finalFight.judgeVotes).forEach(decision => {
                    if (decision === '1') votes.fighter1++;
                    else if (decision === '2') votes.fighter2++;
                    else if (decision === 'tie') votes.tie++;
                });
                
                console.log('🏆 RESULTADOS - Análisis de votos final:', {
                    fighter1: `${this.competitors[finalFight.fighter1Index].name} (${votes.fighter1} votos)`,
                    fighter2: `${this.competitors[finalFight.fighter2Index].name} (${votes.fighter2} votos)`,
                    empates: votes.tie,
                    judgeVotes: finalFight.judgeVotes
                });
                
                let champion;
                if (votes.fighter1 > votes.fighter2) {
                    champion = this.competitors[finalFight.fighter1Index];
                    console.log(`✅ RESULTADOS - CAMPEÓN: ${champion.name} (fighter1 ganó ${votes.fighter1} vs ${votes.fighter2})`);
                } else if (votes.fighter2 > votes.fighter1) {
                    champion = this.competitors[finalFight.fighter2Index];
                    console.log(`✅ RESULTADOS - CAMPEÓN: ${champion.name} (fighter2 ganó ${votes.fighter2} vs ${votes.fighter1})`);
                } else {
                    // En caso de empate en la final, gana quien tenga más puntos de jueces en la final
                    const fighter1 = this.competitors[finalFight.fighter1Index];
                    const fighter2 = this.competitors[finalFight.fighter2Index];
                    champion = votes.fighter1 >= votes.fighter2 ? fighter1 : fighter2;
                    console.log(`⚖️ RESULTADOS - EMPATE EN VOTOS: Campeón por criterio: ${champion.name}`);
                }
                
                championMessage = `
                    <div style="text-align: center; margin-bottom: 20px; padding: 20px; background: linear-gradient(135deg, #f1c40f, #f39c12); border-radius: 15px; color: white;">
                        <h2 style="margin: 0; font-size: 2rem;">🏆 CAMPEÓN DE LA CATEGORÍA</h2>
                        <h3 style="margin: 10px 0; font-size: 1.5rem;">${champion.name}</h3>
                        <p style="margin: 5px 0;">Ganador de la Final</p>
                    </div>
                `;
            }
            
            finalStandings.innerHTML = `
                ${championMessage}
                <div class="final-standings-table">
                    <h3>📊 Resultados por Llaves</h3>
                    ${this.brackets.map(bracket => `
                        <div style="margin: 20px 0; padding: 15px; background: #f8f9fa; border-radius: 10px; border-left: 5px solid #3498db;">
                            <h4 style="color: #2c3e50; margin-bottom: 10px;">${bracket.name}</h4>
                            <table style="width: 100%; border-collapse: collapse;">
                                <thead>
                                    <tr style="background: #3498db; color: white;">
                                        <th style="padding: 8px;">Pos</th>
                                        <th style="padding: 8px;">Competidor</th>
                                        <th style="padding: 8px;">Puntos</th>
                                        <th style="padding: 8px;">Pts Jueces</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${bracket.competitors
                                        .sort((a, b) => {
                                            if (b.victoryPoints !== a.victoryPoints) return b.victoryPoints - a.victoryPoints;
                                            return b.judgePoints - a.judgePoints;
                                        })
                                        .map((competitor, index) => `
                                            <tr style="border-bottom: 1px solid #ddd; ${index === 0 ? 'background: #27ae60; color: white; font-weight: bold;' : ''}">
                                                <td style="padding: 8px; text-align: center;">${index + 1}°</td>
                                                <td style="padding: 8px;">${competitor.name}</td>
                                                <td style="padding: 8px; text-align: center;"><strong>${competitor.victoryPoints}</strong></td>
                                                <td style="padding: 8px; text-align: center;">${competitor.judgePoints}</td>
                                            </tr>
                                        `).join('')}
                                </tbody>
                            </table>
                        </div>
                    `).join('')}
                </div>
            `;
        } else {
            // Sistema Round Robin tradicional
            const sortedCompetitors = [...this.competitors].sort((a, b) => {
                // Primero: Por puntos del sistema 3-1-0 (victoryPoints)
                if (b.victoryPoints !== a.victoryPoints) {
                    return b.victoryPoints - a.victoryPoints;
                }
                // En empate: Por puntos de jueces como desempate
                return b.judgePoints - a.judgePoints;
            });

            finalStandings.innerHTML = `
                <div class="final-standings-table">
                    <h3>🏆 Clasificación Final</h3>
                    <table style="width: 100%; border-collapse: collapse; margin-top: 20px;">
                        <thead>
                            <tr style="background: #3498db; color: white;">
                                <th style="padding: 10px;">Pos</th>
                                <th style="padding: 10px;">Competidor</th>
                                <th style="padding: 10px;">Puntos</th>
                                <th style="padding: 10px;">G-E-P</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${sortedCompetitors.map((competitor, index) => `
                                <tr style="border-bottom: 1px solid #ddd; ${index === 0 ? 'background: #f1c40f; font-weight: bold;' : ''}">
                                    <td style="padding: 10px; text-align: center;">${index + 1}°</td>
                                    <td style="padding: 10px;">${competitor.name}</td>
                                    <td style="padding: 10px; text-align: center;"><strong>${competitor.victoryPoints}</strong></td>
                                    <td style="padding: 10px; text-align: center;">${competitor.wins}-${competitor.ties}-${competitor.losses}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            `;
        }

        document.getElementById('tournament-result-modal').style.display = 'block';
    }

    closeTournamentModal() {
        document.getElementById('tournament-result-modal').style.display = 'none';
        
        // Mostrar sección de resultados finales permanente
        this.showFinalResultsSection();
    }

    showFinalResultsSection() {
        // Crear o mostrar sección de resultados finales
        let finalSection = document.getElementById('final-results-section');
        
        if (!finalSection) {
            finalSection = document.createElement('section');
            finalSection.id = 'final-results-section';
            finalSection.className = 'final-results-section';
            
            // Insertar antes del footer
            const footer = document.querySelector('.footer');
            footer.parentNode.insertBefore(finalSection, footer);
        }
        
        // Obtener competidores ordenados (mismo criterio que updateStandings)
        const sortedCompetitors = [...this.competitors].sort((a, b) => {
            if (b.victoryPoints !== a.victoryPoints) {
                return b.victoryPoints - a.victoryPoints;
            }
            if (b.judgePoints !== a.judgePoints) {
                return b.judgePoints - a.judgePoints;
            }
            const aTiebreakers = a.tiebreakerWins || 0;
            const bTiebreakers = b.tiebreakerWins || 0;
            if (bTiebreakers !== aTiebreakers) {
                return bTiebreakers - aTiebreakers;
            }
            return a.name.localeCompare(b.name);
        });
        
        finalSection.innerHTML = `
            <div class="final-results-container">
                <h2><i class="fas fa-trophy"></i> Categoría Finalizada - Resultados</h2>
                
                <div class="tournament-summary">
                    <div class="summary-item">
                        <h4>Categoría</h4>
                        <span>${this.categoryInfo.gender} ${this.categoryInfo.ageFrom}-${this.categoryInfo.ageTo} años</span>
                    </div>
                    <div class="summary-item">
                        <h4>Cinturones</h4>
                        <span>${this.categoryInfo.beltCategory}</span>
                    </div>
                    <div class="summary-item">
                        <h4>Peso</h4>
                        <span>${this.categoryInfo.weightCategory}</span>
                    </div>
                    <div class="summary-item">
                        <h4>Competidores</h4>
                        <span>${this.competitors.length}</span>
                    </div>
                    <div class="summary-item">
                        <h4>Combates</h4>
                        <span>${this.fights.filter(f => f.completed).length}</span>
                    </div>
                </div>
                
                <div class="podium">
                    ${this.competitorCount > 5 ? this.generateBracketPodium() : this.generateRoundRobinPodium(sortedCompetitors)}
                </div>
                
                <div class="final-actions">
                    <button class="action-btn results-btn" onclick="tournament.showTournamentResults()">
                        <i class="fas fa-table"></i>
                        Ver Tabla Completa
                    </button>
                    <button class="action-btn export-btn" onclick="tournament.exportResults()">
                        <i class="fas fa-download"></i>
                        Exportar Resultados
                    </button>
                    <button class="action-btn new-btn" onclick="tournament.newTournament()">
                        <i class="fas fa-plus"></i>
                        Nueva Categoría
                    </button>
                </div>
            </div>
        `;
        
        finalSection.style.display = 'block';
        
        // Scroll suave hacia los resultados
        finalSection.scrollIntoView({ behavior: 'smooth' });
    }

    newTournament() {
        // Confirmar antes de limpiar todo
        if (this.competitors.length > 0) {
            const confirmMsg = `⚠️ LIMPIAR TODO\n\n` +
                `Esto borrará completamente:\n` +
                `• Todos los competidores\n` +
                `• Todos los combates realizados\n` +
                `• El historial completo\n` +
                `• Los datos guardados\n\n` +
                `¿Estás seguro de que quieres empezar un torneo completamente nuevo?`;
            
            if (!confirm(confirmMsg)) {
                return; // No hacer nada si cancela
            }
        }
        
        // Reset completo
        this.competitors = [];
        this.fights = [];
        this.currentFightIndex = 0;
        this.judgeDecisions = {};
        this.competitorCount = 5;
        this.brackets = [];
        this.currentPhase = 'setup';
        this.groupWinners = [];
        this.categoryInfo = {
            gender: '',
            ageFrom: '',
            ageTo: '',
            beltCategory: '',
            weightCategory: ''
        };
        
        // Limpiar localStorage
        localStorage.removeItem('taekwondo_tournament');
        
        // Limpiar inputs
        document.querySelectorAll('input[type="text"]').forEach(input => input.value = '');
        
        // Resetear selectores
        document.getElementById('competitor-count').value = '5';
        document.getElementById('gender').value = 'Masculino';
        document.getElementById('belt-category').value = 'Blanco a Punta Amarilla';
        document.getElementById('weight-category').value = 'Liviano 1';
        document.getElementById('custom-belt').style.display = 'none';
        this.updateCompetitorInputs(5);
        
        // Mostrar setup inicial
        document.getElementById('setup-section').style.display = 'block';
        document.getElementById('fight-section').style.display = 'none';
        document.getElementById('tournament-result-modal').style.display = 'none';
        
        // Ocultar sección de resultados finales si existe
        const finalSection = document.getElementById('final-results-section');
        if (finalSection) {
            finalSection.style.display = 'none';
        }
        
        // Limpiar displays
        document.getElementById('standings-body').innerHTML = '';
        document.getElementById('fights-list').innerHTML = '';
        document.getElementById('schedule-list').innerHTML = '';
        
        // Confirmar reset
        alert('✅ Nuevo torneo iniciado!\n\nTodos los datos han sido limpiados. Puedes comenzar una nueva categoría.');
    }

    generateBracketPodium() {
        // Para sistema de brackets, mostrar ganadores de cada llave
        console.log('🏆 GENERANDO PODIUM - Iniciando análisis...');
        
        // APLICAR AUTO-CORRECCIÓN AQUÍ TAMBIÉN
        if (this.competitorCount > 5 && this.groupWinners.length === 2) {
            let finalFight = this.fights.find(f => f.isFinal && f.completed);
            
            if (!finalFight) {
                console.log('⚠️ PODIUM: No se encuentra final marcada, aplicando auto-corrección...');
                // Buscar pelea entre ganadores de llaves
                const winner1Index = this.competitors.findIndex(c => c.id === this.groupWinners[0]);
                const winner2Index = this.competitors.findIndex(c => c.id === this.groupWinners[1]);
                
                // Buscar TODAS las peleas entre ganadores (incluye desempates)
                const fightsBetweenWinners = this.fights.filter(f => 
                    f.completed &&
                    ((f.fighter1Index === winner1Index && f.fighter2Index === winner2Index) ||
                     (f.fighter1Index === winner2Index && f.fighter2Index === winner1Index))
                );
                
                if (fightsBetweenWinners.length > 0) {
                    // Usar la última pelea (puede ser un desempate)
                    const existingFight = fightsBetweenWinners[fightsBetweenWinners.length - 1];
                    console.log('✅ PODIUM: Encontrada pelea entre ganadores, marcando como final');
                    existingFight.isFinal = true;
                    finalFight = existingFight;
                }
            }
            
            console.log('🔍 PODIUM - Estado de final:', {
                finalFightFound: !!finalFight,
                finalCompleted: finalFight ? finalFight.completed : false,
                finalResult: finalFight ? finalFight.result : null,
                groupWinners: this.groupWinners.map(id => this.competitors.find(c => c.id === id)?.name)
            });
        }
        
        const finalFight = this.fights.find(f => f.isFinal && f.completed);
        
        if (finalFight) {
            // Si la final ya se jugó, mostrar 1º y 2º
            const votes = { fighter1: 0, fighter2: 0, tie: 0 };
            Object.values(finalFight.judgeVotes).forEach(decision => {
                if (decision === '1') votes.fighter1++;
                else if (decision === '2') votes.fighter2++;
                else if (decision === 'tie') votes.tie++;
            });

            console.log('🏆 PODIUM - Análisis de votos final:', {
                fighter1: `${this.competitors[finalFight.fighter1Index].name} (${votes.fighter1} votos)`,
                fighter2: `${this.competitors[finalFight.fighter2Index].name} (${votes.fighter2} votos)`,
                empates: votes.tie,
                judgeVotes: finalFight.judgeVotes
            });

            let champion, runnerUp;
            if (votes.fighter1 > votes.fighter2) {
                champion = this.competitors[finalFight.fighter1Index];
                runnerUp = this.competitors[finalFight.fighter2Index];
                console.log(`✅ PODIUM - CAMPEÓN: ${champion.name} (fighter1 ganó ${votes.fighter1} vs ${votes.fighter2})`);
            } else if (votes.fighter2 > votes.fighter1) {
                champion = this.competitors[finalFight.fighter2Index];
                runnerUp = this.competitors[finalFight.fighter1Index];
                console.log(`✅ PODIUM - CAMPEÓN: ${champion.name} (fighter2 ganó ${votes.fighter2} vs ${votes.fighter1})`);
            } else {
                // En caso de empate, usar puntos de jueces de la final
                champion = votes.fighter1 >= votes.fighter2 ? 
                    this.competitors[finalFight.fighter1Index] : 
                    this.competitors[finalFight.fighter2Index];
                runnerUp = champion === this.competitors[finalFight.fighter1Index] ? 
                    this.competitors[finalFight.fighter2Index] : 
                    this.competitors[finalFight.fighter1Index];
                console.log(`⚖️ PODIUM - EMPATE EN VOTOS: Campeón por criterio: ${champion.name}`);
            }

            return `
                <div class="podium-place place-1">
                    <div class="place-number">1°</div>
                    <div class="competitor-name">${champion.name}</div>
                    <div class="competitor-stats">
                        <span class="victories">🏆 CAMPEÓN</span>
                        <span class="judges">Ganador de la Final</span>
                    </div>
                </div>
                <div class="podium-place place-2">
                    <div class="place-number">2°</div>
                    <div class="competitor-name">${runnerUp.name}</div>
                    <div class="competitor-stats">
                        <span class="victories">🥈 SUBCAMPEÓN</span>
                        <span class="judges">Finalista</span>
                    </div>
                </div>
            `;
        } else {
            // Si la final no se ha jugado, mostrar ganadores de cada llave
            const winner1 = this.competitors.find(c => c.id === this.groupWinners[0]);
            const winner2 = this.competitors.find(c => c.id === this.groupWinners[1]);
            
            return `
                <div class="podium-place place-1">
                    <div class="place-number">1°</div>
                    <div class="competitor-name">${winner1.name}</div>
                    <div class="competitor-stats">
                        <span class="victories">👑 Ganador ${this.brackets[0].name}</span>
                        <span class="judges">${winner1.judgePoints} jueces</span>
                    </div>
                </div>
                <div class="podium-place place-1">
                    <div class="place-number">1°</div>
                    <div class="competitor-name">${winner2.name}</div>
                    <div class="competitor-stats">
                        <span class="victories">👑 Ganador ${this.brackets[1].name}</span>
                        <span class="judges">${winner2.judgePoints} jueces</span>
                    </div>
                </div>
            `;
        }
    }

    generateRoundRobinPodium(sortedCompetitors) {
        // Para Round Robin, mostrar solo 1º y 2º lugar (sin 3º puesto)
        return sortedCompetitors.slice(0, 2).map((competitor, index) => `
            <div class="podium-place place-${index + 1}">
                <div class="place-number">${index + 1}°</div>
                <div class="competitor-name">${competitor.name}</div>
                <div class="competitor-stats">
                    <span class="victories">${competitor.victoryPoints} victorias</span>
                    <span class="judges">${competitor.judgePoints} jueces</span>
                </div>
            </div>
        `).join('');
    }

    exportResults() {
        // Mostrar opciones de exportación
        const exportChoice = confirm(
            "📊 EXPORTAR RESULTADOS\n\n" +
            "✅ OK = Reporte Completo (PDF profesional)\n" +
            "❌ Cancelar = Datos CSV (solo números)\n\n" +
            "¿Qué tipo de exportación prefieres?"
        );

        if (exportChoice) {
            this.exportProfessionalReport();
        } else {
            this.exportCSVData();
        }
    }

    exportProfessionalReport() {
        // Crear reporte HTML completo para convertir a PDF
        const sortedCompetitors = [...this.competitors].sort((a, b) => {
            if (b.victoryPoints !== a.victoryPoints) {
                return b.victoryPoints - a.victoryPoints;
            }
            if (b.judgePoints !== a.judgePoints) {
                return b.judgePoints - a.judgePoints;
            }
            const aTiebreakers = a.tiebreakerWins || 0;
            const bTiebreakers = b.tiebreakerWins || 0;
            if (bTiebreakers !== aTiebreakers) {
                return bTiebreakers - aTiebreakers;
            }
            return a.name.localeCompare(b.name);
        });

        const reportContent = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Reporte de Categoría - Taekwon-Do</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; background: #f8f9fa; }
        .header { text-align: center; margin-bottom: 30px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 10px; }
        .category-info { background: white; padding: 20px; border-radius: 10px; margin-bottom: 20px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .info-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; }
        .info-item { text-align: center; padding: 10px; background: #f8f9fa; border-radius: 8px; }
        .info-label { font-weight: bold; color: #666; font-size: 0.9rem; }
        .info-value { font-size: 1.1rem; color: #2c3e50; margin-top: 5px; }
        .podium { display: flex; justify-content: center; margin: 30px 0; gap: 20px; }
        .podium-place { text-align: center; padding: 20px; border-radius: 10px; min-width: 150px; }
        .place-1 { background: linear-gradient(145deg, #f1c40f, #f39c12); color: white; transform: scale(1.1); }
        .place-2 { background: linear-gradient(145deg, #95a5a6, #7f8c8d); color: white; }
        .place-3 { background: linear-gradient(145deg, #cd7f32, #b8860b); color: white; }
        .place-number { font-size: 2rem; font-weight: bold; }
        .competitor-name { font-size: 1.2rem; margin: 10px 0; }
        .table-container { background: white; padding: 20px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); margin: 20px 0; }
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 12px; text-align: center; border-bottom: 1px solid #ddd; }
        th { background: #3498db; color: white; font-weight: bold; }
        tr:nth-child(even) { background: #f8f9fa; }
        tr:hover { background: #e3f2fd; }
        .winner { background: #d4edda !important; font-weight: bold; }
        .fights-section { background: white; padding: 20px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); margin: 20px 0; }
        .fight-item { display: flex; justify-content: space-between; padding: 10px; border-bottom: 1px solid #eee; }
        .fight-item.tiebreaker { background: #fff5f5; border-left: 4px solid #e74c3c; }
        .tiebreaker-tag { background: #e74c3c; color: white; padding: 2px 8px; border-radius: 12px; font-size: 0.8rem; }
        .footer { text-align: center; margin-top: 30px; color: #666; font-size: 0.9rem; }
    </style>
</head>
<body>
    <div class="header">
        <h1>🏆 REPORTE OFICIAL DE CATEGORÍA</h1>
        <h2>TAEKWON-DO</h2>
    </div>

    <div class="category-info">
        <h3>📋 Información de la Categoría</h3>
        <div class="info-grid">
            <div class="info-item">
                <div class="info-label">Género</div>
                <div class="info-value">${this.categoryInfo.gender}</div>
            </div>
            <div class="info-item">
                <div class="info-label">Edad</div>
                <div class="info-value">${this.categoryInfo.ageFrom} - ${this.categoryInfo.ageTo} años</div>
            </div>
            <div class="info-item">
                <div class="info-label">Cinturones</div>
                <div class="info-value">${this.categoryInfo.beltCategory}</div>
            </div>
            <div class="info-item">
                <div class="info-label">Peso</div>
                <div class="info-value">${this.categoryInfo.weightCategory}</div>
            </div>
            <div class="info-item">
                <div class="info-label">Fecha</div>
                <div class="info-value">${new Date().toLocaleDateString('es-ES')}</div>
            </div>
        </div>
    </div>

    <div class="podium">
        ${sortedCompetitors.slice(0, this.currentPhase === 'roundrobin' ? 2 : 3).map((competitor, index) => `
            <div class="podium-place place-${index + 1}">
                <div class="place-number">${index + 1}°</div>
                <div class="competitor-name">${competitor.name}</div>
                <div>${competitor.victoryPoints} victorias</div>
                <div>${competitor.judgePoints} pts jueces</div>
            </div>
        `).join('')}
    </div>

    ${this.currentPhase === 'roundrobin' ? 
        '<div style="text-align: center; margin: 15px 0; color: #7f8c8d; font-style: italic;">* Sistema Round Robin: Solo se otorgan 1° y 2° puesto oficial</div>' : 
        ''
    }

    <div class="table-container">
        <h3>📊 Clasificación Final</h3>
        <table>
            <thead>
                <tr>
                    <th>Pos</th>
                    <th>Competidor</th>
                    <th>Peleas</th>
                    <th>Ganadas</th>
                    <th>Empates</th>
                    <th>Perdidas</th>
                    <th>Pts Victoria</th>
                    <th>Pts Jueces</th>
                    ${this.competitors.some(c => c.tiebreakerWins) ? '<th>Desempates</th>' : ''}
                </tr>
            </thead>
            <tbody>
                ${sortedCompetitors.map((competitor, index) => `
                    <tr class="${index === 0 ? 'winner' : ''}">
                        <td>${index + 1}°</td>
                        <td><strong>${competitor.name}</strong></td>
                        <td>${competitor.fights}</td>
                        <td>${competitor.wins}</td>
                        <td>${competitor.ties}</td>
                        <td>${competitor.losses}</td>
                        <td><strong>${competitor.victoryPoints}</strong></td>
                        <td><strong>${competitor.judgePoints}</strong></td>
                        ${this.competitors.some(c => c.tiebreakerWins) ? `<td>${competitor.tiebreakerWins || 0}</td>` : ''}
                    </tr>
                `).join('')}
            </tbody>
        </table>
    </div>

    <div class="fights-section">
        <h3>🥊 Historial de Combates</h3>
        ${this.fights.filter(f => f.completed).map((fight, index) => {
            const fighter1 = this.competitors[fight.fighter1Index];
            const fighter2 = this.competitors[fight.fighter2Index];
            const date = fight.completedAt ? new Date(fight.completedAt) : new Date();
            return `
                <div class="fight-item ${fight.isTiebreaker ? 'tiebreaker' : ''}">
                    <div>
                        <strong>${fighter1.name} vs ${fighter2.name}</strong>
                        ${fight.isTiebreaker ? '<span class="tiebreaker-tag">DESEMPATE</span>' : ''}
                        <br>
                        <small>${date.toLocaleDateString('es-ES')} - ${date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}</small>
                    </div>
                    <div>
                        <strong>${fight.result}</strong>
                    </div>
                </div>
            `;
        }).join('')}
    </div>

    <div class="footer">
        <p>📅 Reporte generado el ${new Date().toLocaleDateString('es-ES')} a las ${new Date().toLocaleTimeString('es-ES')}</p>
        <p>🥋 Sistema de Puntuación Taekwon-Do - Brian E. Lipnjak</p>
    </div>
</body>
</html>`;

        // Crear y descargar el archivo HTML
        const blob = new Blob([reportContent], { type: 'text/html;charset=utf-8' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        
        const categoryName = `${this.categoryInfo.gender}_${this.categoryInfo.ageFrom}-${this.categoryInfo.ageTo}_${this.categoryInfo.beltCategory}_${this.categoryInfo.weightCategory}`.replace(/\s+/g, '_');
        link.download = `Reporte_Taekwondo_${categoryName}_${new Date().toISOString().split('T')[0]}.html`;
        
        link.click();
        
        alert('📄 ¡Reporte generado!\n\nSe descargó un archivo HTML que puedes:\n• Abrir en cualquier navegador\n• Imprimir como PDF\n• Compartir fácilmente');
    }

    exportCSVData() {
        const sortedCompetitors = [...this.competitors].sort((a, b) => {
            if (b.victoryPoints !== a.victoryPoints) {
                return b.victoryPoints - a.victoryPoints;
            }
            if (b.judgePoints !== a.judgePoints) {
                return b.judgePoints - a.judgePoints;
            }
            const aTiebreakers = a.tiebreakerWins || 0;
            const bTiebreakers = b.tiebreakerWins || 0;
            if (bTiebreakers !== aTiebreakers) {
                return bTiebreakers - aTiebreakers;
            }
            return a.name.localeCompare(b.name);
        });

        let csvContent = "data:text/csv;charset=utf-8,";
        
        // Información de categoría
        csvContent += "CATEGORIA DE TAEKWON-DO\\n";
        csvContent += `Genero,${this.categoryInfo.gender}\\n`;
        csvContent += `Edad,${this.categoryInfo.ageFrom}-${this.categoryInfo.ageTo} años\\n`;
        csvContent += `Cinturones,${this.categoryInfo.beltCategory}\\n`;
        csvContent += `Peso,${this.categoryInfo.weightCategory}\\n`;
        csvContent += `Fecha,${new Date().toLocaleDateString('es-ES')}\\n\\n`;
        
        // Encabezados de tabla
        csvContent += "Posicion,Nombre,Peleas,Ganadas,Empates,Perdidas,Pts_Victoria,Pts_Jueces";
        if (this.competitors.some(c => c.tiebreakerWins)) {
            csvContent += ",Desempates_Ganados";
        }
        csvContent += "\\n";
        
        // Datos de competidores
        sortedCompetitors.forEach((competitor, index) => {
            csvContent += `${index + 1},${competitor.name},${competitor.fights},${competitor.wins},${competitor.ties},${competitor.losses},${competitor.victoryPoints},${competitor.judgePoints}`;
            if (this.competitors.some(c => c.tiebreakerWins)) {
                csvContent += `,${competitor.tiebreakerWins || 0}`;
            }
            csvContent += "\\n";
        });

        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        
        const categoryName = `${this.categoryInfo.gender}_${this.categoryInfo.ageFrom}-${this.categoryInfo.ageTo}_${this.categoryInfo.weightCategory}`.replace(/\s+/g, '_');
        link.setAttribute("download", `Datos_Taekwondo_${categoryName}_${new Date().toISOString().split('T')[0]}.csv`);
        
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        alert('📊 ¡Datos CSV exportados!\n\nArchivo con datos básicos para análisis en Excel.');
    }

    // Métodos para sistema de llaves
    createBrackets() {
        this.brackets = [];
        
        if (this.competitorCount === 6) {
            // 2 llaves de 3
            this.brackets = [
                { id: 1, name: 'Llave A', competitors: this.competitors.slice(0, 3), completed: false },
                { id: 2, name: 'Llave B', competitors: this.competitors.slice(3, 6), completed: false }
            ];
        } else if (this.competitorCount === 7) {
            // 1 llave de 4 + 1 llave de 3
            this.brackets = [
                { id: 1, name: 'Llave A', competitors: this.competitors.slice(0, 4), completed: false },
                { id: 2, name: 'Llave B', competitors: this.competitors.slice(4, 7), completed: false }
            ];
        } else if (this.competitorCount === 8) {
            // 2 llaves de 4
            this.brackets = [
                { id: 1, name: 'Llave A', competitors: this.competitors.slice(0, 4), completed: false },
                { id: 2, name: 'Llave B', competitors: this.competitors.slice(4, 8), completed: false }
            ];
        }
        
        // Asignar llave a cada competidor
        this.brackets.forEach(bracket => {
            bracket.competitors.forEach(competitor => {
                competitor.bracket = bracket.id;
            });
        });
    }

    generateGroupStage() {
        this.fights = [];
        
        // Generar peleas optimizadas para cada llave
        this.brackets.forEach(bracket => {
            console.log(`🔧 Optimizando peleas para ${bracket.name} (${bracket.competitors.length} competidores)`);
            
            // Generar todas las combinaciones posibles para este bracket
            const bracketFights = [];
            for (let i = 0; i < bracket.competitors.length; i++) {
                for (let j = i + 1; j < bracket.competitors.length; j++) {
                    const fighter1Index = this.competitors.findIndex(c => c.id === bracket.competitors[i].id);
                    const fighter2Index = this.competitors.findIndex(c => c.id === bracket.competitors[j].id);
                    
                    bracketFights.push({
                        fighter1Index: fighter1Index,
                        fighter2Index: fighter2Index,
                        bracket: bracket.id,
                        completed: false,
                        result: null,
                        judgeVotes: {
                            judge1: null,
                            judge2: null,
                            judge3: null,
                            judge4: null
                        }
                    });
                }
            }
            
            // Aplicar optimización según el tamaño del bracket
            let optimizedFights;
            if (bracket.competitors.length === 3) {
                optimizedFights = this.optimizeBracketFor3Fighters(bracketFights, bracket);
                console.log(`✅ ${bracket.name}: Aplicada optimización para 3 competidores`);
            } else if (bracket.competitors.length === 4) {
                optimizedFights = this.optimizeBracketFor4Fighters(bracketFights, bracket);
                console.log(`✅ ${bracket.name}: Aplicada optimización para 4 competidores`);
            } else {
                optimizedFights = this.optimizeBracketGeneral(bracketFights, bracket);
                console.log(`✅ ${bracket.name}: Aplicada optimización general para ${bracket.competitors.length} competidores`);
            }
            
            // Agregar las peleas optimizadas al array principal
            this.fights.push(...optimizedFights);
        });
        
        console.log(`🏆 Total de peleas generadas: ${this.fights.length}`);
    }

    showBracketsSection() {
        document.getElementById('setup-section').style.display = 'none';
        document.getElementById('brackets-section').style.display = 'block';
        document.getElementById('fight-section').style.display = 'block';
        this.showTournamentInfo(); // Mostrar información de categoría
        this.updateBracketsDisplay();
    }

    showFightSection() {
        document.getElementById('setup-section').style.display = 'none';
        document.getElementById('fight-section').style.display = 'block';
        this.showTournamentInfo(); // Mostrar información de categoría
    }

    updateBracketStatistics() {
        // Solo actualizar estadísticas para competidores en brackets
        const bracketCompetitorIds = this.brackets.flatMap(bracket => 
            bracket.competitors.map(c => c.id)
        );
        
        // Reiniciar estadísticas solo de competidores en brackets
        this.competitors.forEach(competitor => {
            if (bracketCompetitorIds.includes(competitor.id)) {
                // Para brackets, las estadísticas globales muestran solo peleas de brackets
                competitor.fights = 0;
                competitor.wins = 0;
                competitor.ties = 0;
                competitor.losses = 0;
                competitor.victoryPoints = 0;
                competitor.judgePoints = 0;
                // También reiniciar contadores específicos de brackets
                competitor.bracketFights = 0;
                competitor.bracketWins = 0;
                competitor.bracketTies = 0;
                competitor.bracketLosses = 0;
                competitor.bracketVictoryPoints = 0;
                competitor.bracketJudgePoints = 0;
            }
        });

        // Recalcular estadísticas basándose en peleas completadas de brackets
        this.fights.forEach(fight => {
            if (fight.isTiebreaker) {
                return; // Los desempates no afectan las estadísticas de llaves
            }
            if (fight.completed && fight.bracket) { // Solo peleas de brackets
                const fighter1 = this.competitors[fight.fighter1Index];
                const fighter2 = this.competitors[fight.fighter2Index];
                
                // Actualizar contadores principales (para display)
                fighter1.fights++;
                fighter2.fights++;
                
                // También actualizar contadores específicos de brackets
                fighter1.bracketFights++;
                fighter2.bracketFights++;

                // Contar votos para determinar resultado
                const votes = { fighter1: 0, fighter2: 0, tie: 0 };
                Object.values(fight.judgeVotes).forEach(decision => {
                    if (decision === '1') votes.fighter1++;
                    else if (decision === '2') votes.fighter2++;
                    else if (decision === 'tie') votes.tie++;
                });

                // Determinar ganador y actualizar estadísticas
                if (votes.fighter1 > votes.fighter2 && votes.fighter1 > votes.tie) {
                    // Fighter1 gana
                    fighter1.wins++;
                    fighter1.victoryPoints += 3;
                    fighter1.bracketWins++;
                    fighter1.bracketVictoryPoints += 3;
                    fighter2.losses++;
                    fighter2.bracketLosses++;
                } else if (votes.fighter2 > votes.fighter1 && votes.fighter2 > votes.tie) {
                    // Fighter2 gana
                    fighter2.wins++;
                    fighter2.victoryPoints += 3;
                    fighter2.bracketWins++;
                    fighter2.bracketVictoryPoints += 3;
                    fighter1.losses++;
                    fighter1.bracketLosses++;
                } else {
                    // Empate (mayoría de votos empate o empate en votos ganadores)
                    fighter1.ties++;
                    fighter2.ties++;
                    fighter1.victoryPoints += 1;
                    fighter2.victoryPoints += 1;
                    fighter1.bracketTies++;
                    fighter2.bracketTies++;
                    fighter1.bracketVictoryPoints += 1;
                    fighter2.bracketVictoryPoints += 1;
                }

                // Asignar puntos de jueces
                fighter1.judgePoints += votes.fighter1;
                fighter2.judgePoints += votes.fighter2;
                fighter1.bracketJudgePoints += votes.fighter1;
                fighter2.bracketJudgePoints += votes.fighter2;
            }
        });
    }

    updateBracketsDisplay() {
        // VERIFICACIÓN AUTOMÁTICA DE FINAL FALTANTE
        if (this.competitorCount > 5 && this.groupWinners.length === 2) {
            const finalFight = this.fights.find(f => f.isFinal);
            if (!finalFight) {
                console.log('🔧 AUTO-CORRECCIÓN: Detectando final faltante y corrigiendo...');
                console.log('🔍 Ganadores de llaves:', this.groupWinners.map(id => 
                    this.competitors.find(c => c.id === id)?.name
                ));
                
                // Buscar si existe una pelea entre los ganadores
                const winner1Index = this.competitors.findIndex(c => c.id === this.groupWinners[0]);
                const winner2Index = this.competitors.findIndex(c => c.id === this.groupWinners[1]);
                
                console.log('🔍 Índices:', { winner1Index, winner2Index });
                
                // Buscar TODAS las peleas entre estos ganadores (incluye desempates)
                const fightsBetweenWinners = this.fights.filter(f => 
                    f.completed &&
                    ((f.fighter1Index === winner1Index && f.fighter2Index === winner2Index) ||
                     (f.fighter1Index === winner2Index && f.fighter2Index === winner1Index))
                );
                
                console.log('🔍 Peleas encontradas:', fightsBetweenWinners.length);
                
                if (fightsBetweenWinners.length > 0) {
                    // Usar la última pelea (puede ser un desempate)
                    const finalToMark = fightsBetweenWinners[fightsBetweenWinners.length - 1];
                    finalToMark.isFinal = true;
                    console.log('✅ AUTO-CORRECCIÓN: Pelea entre ganadores marcada como final:', {
                        fighter1: this.competitors[finalToMark.fighter1Index]?.name,
                        fighter2: this.competitors[finalToMark.fighter2Index]?.name,
                        result: finalToMark.result
                    });
                } else {
                    console.log('❌ No se encontraron peleas entre ganadores');
                }
            }
        }
        
        // Primero actualizar las estadísticas de todos los competidores
        this.updateBracketStatistics();
        
        const container = document.getElementById('brackets-container');
        container.innerHTML = '';
        
        this.brackets.forEach(bracket => {
            const bracketDiv = document.createElement('div');
            bracketDiv.className = 'bracket';
            
            // Ordenar competidores dentro del bracket por estadísticas
            const sortedCompetitors = [...bracket.competitors].sort((a, b) => {
                // Primero por puntos de victoria
                if (b.victoryPoints !== a.victoryPoints) {
                    return b.victoryPoints - a.victoryPoints;
                }
                // Luego por puntos de jueces
                if (b.judgePoints !== a.judgePoints) {
                    return b.judgePoints - a.judgePoints;
                }
                // Finalmente alfabético
                return a.name.localeCompare(b.name);
            });
            
            bracketDiv.innerHTML = `
                <h3>${bracket.name}</h3>
                <div class="bracket-competitors">
                    ${sortedCompetitors.map((competitor, index) => `
                        <div class="bracket-competitor ${this.groupWinners.includes(competitor.id) ? 'qualified' : ''}">
                            <div style="display: flex; justify-content: space-between; align-items: center;">
                                <span style="font-weight: ${index === 0 ? 'bold' : 'normal'};">
                                    ${index + 1}º ${competitor.name}
                                </span>
                                ${index === 0 && this.currentPhase === 'groups' ? '<span style="color: #27ae60;">👑</span>' : ''}
                            </div>
                            <small style="display: block; font-size: 0.8em; margin-top: 5px;">
                                ${competitor.victoryPoints} pts (${competitor.wins}G-${competitor.ties}E-${competitor.losses}P)
                            </small>
                        </div>
                    `).join('')}
                </div>
            `;
            container.appendChild(bracketDiv);
        });
        
        // Si estamos en fase final, mostrar la final
        if (this.currentPhase === 'final' && this.groupWinners.length === 2) {
            const finalDiv = document.createElement('div');
            finalDiv.className = 'bracket final-bracket';
            const winner1 = this.competitors.find(c => c.id === this.groupWinners[0]);
            const winner2 = this.competitors.find(c => c.id === this.groupWinners[1]);
            
            // Buscar si ya se completó la final
            const finalFight = this.fights.find(f => f.isFinal);
            let finalResult = '';
            let champion = null;
            
            console.log('🔍 DEBUG FINAL - Estado de final:', {
                finalFightFound: !!finalFight,
                finalCompleted: finalFight ? finalFight.completed : false,
                groupWinners: this.groupWinners,
                currentPhase: this.currentPhase,
                totalFights: this.fights.length,
                finalDetails: finalFight ? {
                    fighter1: this.competitors[finalFight.fighter1Index]?.name,
                    fighter2: this.competitors[finalFight.fighter2Index]?.name,
                    result: finalFight.result,
                    isFinal: finalFight.isFinal
                } : null
            });
            
            if (finalFight && finalFight.completed) {
                // La final ya se jugó - determinar ganador por votos de jueces
                const votes = { fighter1: 0, fighter2: 0, tie: 0 };
                Object.values(finalFight.judgeVotes).forEach(decision => {
                    if (decision === '1') votes.fighter1++;
                    else if (decision === '2') votes.fighter2++;
                    else if (decision === 'tie') votes.tie++;
                });

                console.log('🏆 FINAL - Análisis de votos:', {
                    fighter1: `${this.competitors[finalFight.fighter1Index].name} (${votes.fighter1} votos)`,
                    fighter2: `${this.competitors[finalFight.fighter2Index].name} (${votes.fighter2} votos)`,
                    ties: `${votes.tie} empates`,
                    resultado: finalFight.result
                });

                if (votes.fighter1 > votes.fighter2) {
                    // Ganó fighter1
                    champion = this.competitors[finalFight.fighter1Index];
                } else if (votes.fighter2 > votes.fighter1) {
                    // Ganó fighter2  
                    champion = this.competitors[finalFight.fighter2Index];
                } else if (votes.tie > 0 || votes.fighter1 === votes.fighter2) {
                    // Empate real en votos de jueces
                    finalResult = `<div class="champion-announcement">⚡ EMPATE EN FINAL - Se requiere desempate</div>`;
                }

                if (champion) {
                    finalResult = `<div class="champion-announcement">🏆 CAMPEÓN: <strong>${champion.name}</strong></div>`;
                }
            }
            
            // SI NO HAY FINAL DETECTADA PERO SÍ HAY GANADORES, INTENTAR CORREGIR
            if (!finalFight && this.groupWinners.length === 2) {
                console.log('⚠️ PROBLEMA DETECTADO: Hay ganadores de llaves pero no hay final generada');
                console.log('🔧 Intentando detectar si la final ya se jugó...');
                
                // Buscar si existe una pelea entre los ganadores de las llaves
                const winner1Index = this.competitors.findIndex(c => c.id === this.groupWinners[0]);
                const winner2Index = this.competitors.findIndex(c => c.id === this.groupWinners[1]);
                
                console.log('🔍 DISPLAY - Buscando final entre ganadores:', {
                    winner1: this.competitors[winner1Index]?.name,
                    winner2: this.competitors[winner2Index]?.name
                });
                
                // Buscar TODAS las peleas entre ganadores (incluye desempates)
                const fightsBetweenWinners = this.fights.filter(f => 
                    f.completed &&
                    ((f.fighter1Index === winner1Index && f.fighter2Index === winner2Index) ||
                     (f.fighter1Index === winner2Index && f.fighter2Index === winner1Index))
                );
                
                if (fightsBetweenWinners.length > 0) {
                    // Usar la última pelea (puede ser un desempate)
                    const existingFinalFight = fightsBetweenWinners[fightsBetweenWinners.length - 1];
                    console.log('✅ ENCONTRADA pelea entre ganadores de llaves - marcando como final');
                    // Marcar esta pelea como la final
                    existingFinalFight.isFinal = true;
                    
                    // Determinar ganador por votos de jueces
                    const votes = { fighter1: 0, fighter2: 0, tie: 0 };
                    Object.values(existingFinalFight.judgeVotes).forEach(decision => {
                        if (decision === '1') votes.fighter1++;
                        else if (decision === '2') votes.fighter2++;
                        else if (decision === 'tie') votes.tie++;
                    });

                    if (votes.fighter1 > votes.fighter2) {
                        champion = this.competitors[existingFinalFight.fighter1Index];
                    } else if (votes.fighter2 > votes.fighter1) {
                        champion = this.competitors[existingFinalFight.fighter2Index];
                    }

                    if (champion) {
                        finalResult = `<div class="champion-announcement">🏆 CAMPEÓN: <strong>${champion.name}</strong></div>`;
                        console.log(`🏆 CAMPEÓN DETERMINADO: ${champion.name}`);
                    }
                } else if (!existingFinalFight) {
                    console.log('🔧 Generando final faltante...');
                    this.generateFinalFight();
                    finalResult = `<div class="champion-announcement">⚡ Final generada - Pendiente de jugar</div>`;
                }
            }
            
            finalDiv.innerHTML = `
                <h3>🏆 FINAL DE LA CATEGORÍA</h3>
                ${finalResult}
                <div class="bracket-competitors">
                    <div class="bracket-competitor qualified ${champion === winner1 ? 'champion' : ''}">
                        ${winner1.name}
                        <small style="display: block; font-size: 0.8em; margin-top: 5px;">
                            Ganador ${this.brackets[0].name}
                        </small>
                    </div>
                    <div class="vs-indicator">VS</div>
                    <div class="bracket-competitor qualified ${champion === winner2 ? 'champion' : ''}">
                        ${winner2.name}
                        <small style="display: block; font-size: 0.8em; margin-top: 5px;">
                            Ganador ${this.brackets[1].name}
                        </small>
                    </div>
                </div>
                ${finalFight && finalFight.completed ? 
                    `<div class="final-result">
                        <strong>Resultado Final:</strong> ${finalFight.result}<br>
                        <small>Fecha: ${finalFight.completedAt ? finalFight.completedAt.toLocaleDateString('es-ES') : ''} - 
                        Hora: ${finalFight.completedAt ? finalFight.completedAt.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : ''}</small>
                    </div>` : 
                    '<div class="final-pending">⏳ Final pendiente</div>'
                }
            `;
            container.appendChild(finalDiv);
        }
    }

    checkGroupStageComplete() {
        // Verificar si todas las peleas de grupos están completadas
        const groupFights = this.fights.filter(f => f.bracket && !f.completed);
        return groupFights.length === 0;
    }

    determineGroupWinners() {
        const resolvedWinners = [];
        let pendingResolution = false;

        for (const bracket of this.brackets) {
            if (!bracket.competitors || bracket.competitors.length === 0) {
                continue;
            }

            bracket.competitors.sort((a, b) => this.compareBracketCompetitors(a, b));

            const leader = bracket.competitors[0];
            const tiedGroup = bracket.competitors.filter(competitor =>
                this.haveSameBracketMetrics(competitor, leader)
            );

            if (tiedGroup.length === bracket.competitors.length && bracket.competitors.length > 1) {
                pendingResolution = true;
                bracket.completed = false;
                bracket.winner = null;
                this.restartBracket(bracket.id);
                break;
            }

            if (tiedGroup.length > 1) {
                pendingResolution = true;
                bracket.completed = false;
                bracket.winner = null;

                if (tiedGroup.length === 2) {
                    this.scheduleBracketTiebreaker(bracket.id, tiedGroup[0], tiedGroup[1]);
                } else {
                    this.restartBracket(bracket.id);
                }
                continue;
            }

            resolvedWinners.push(leader.id);
            bracket.completed = true;
            bracket.winner = leader;
        }

        if (!pendingResolution && resolvedWinners.length === this.brackets.length) {
            this.groupWinners = resolvedWinners;
            console.log('Ganadores de llaves:', this.groupWinners);
            return true;
        }

        this.groupWinners = resolvedWinners;
        return false;
    }

    getBracketMetrics(competitor) {
        return {
            wins: competitor.bracketWins ?? competitor.wins ?? 0,
            judgePoints: competitor.bracketJudgePoints ?? competitor.judgePoints ?? 0,
            tiebreakerWins: competitor.tiebreakerWins ?? 0,
            victoryPoints: competitor.bracketVictoryPoints ?? competitor.victoryPoints ?? 0
        };
    }

    compareBracketCompetitors(a, b) {
        const metricsA = this.getBracketMetrics(a);
        const metricsB = this.getBracketMetrics(b);

        if (metricsB.wins !== metricsA.wins) {
            return metricsB.wins - metricsA.wins;
        }
        if (metricsB.judgePoints !== metricsA.judgePoints) {
            return metricsB.judgePoints - metricsA.judgePoints;
        }
        if (metricsB.tiebreakerWins !== metricsA.tiebreakerWins) {
            return metricsB.tiebreakerWins - metricsA.tiebreakerWins;
        }
        if (metricsB.victoryPoints !== metricsA.victoryPoints) {
            return metricsB.victoryPoints - metricsA.victoryPoints;
        }
        return a.name.localeCompare(b.name);
    }

    haveSameBracketMetrics(a, b) {
        const metricsA = this.getBracketMetrics(a);
        const metricsB = this.getBracketMetrics(b);

        return (
            metricsA.wins === metricsB.wins &&
            metricsA.judgePoints === metricsB.judgePoints &&
            metricsA.tiebreakerWins === metricsB.tiebreakerWins &&
            metricsA.victoryPoints === metricsB.victoryPoints
        );
    }

    scheduleBracketTiebreaker(bracketId, fighter1, fighter2) {
        const fighter1Index = this.competitors.findIndex(c => c.id === fighter1.id);
        const fighter2Index = this.competitors.findIndex(c => c.id === fighter2.id);

        const pendingFight = this.fights.find(fight =>
            fight.isTiebreaker &&
            !fight.completed &&
            this.isSameFightPair(fight, fighter1Index, fighter2Index)
        );
        if (pendingFight) {
            return;
        }

        const resolvedFight = this.fights.find(fight =>
            fight.isTiebreaker &&
            fight.completed &&
            fight.result &&
            fight.result.includes('ganó DESEMPATE') &&
            this.isSameFightPair(fight, fighter1Index, fighter2Index)
        );
        if (resolvedFight) {
            return;
        }

        this.createTiebreakerFight(fighter1, fighter2, bracketId);
    }

    isSameFightPair(fight, fighter1Index, fighter2Index) {
        return (
            (fight.fighter1Index === fighter1Index && fight.fighter2Index === fighter2Index) ||
            (fight.fighter1Index === fighter2Index && fight.fighter2Index === fighter1Index)
        );
    }

    restartBracket(bracketId) {
        const bracket = this.brackets.find(b => b.id === bracketId);
        if (!bracket) {
            return;
        }

        const competitorIds = bracket.competitors.map(c => c.id);

        this.fights = this.fights.filter(fight => {
            if (fight.bracket === bracketId) {
                return false;
            }
            if (fight.isTiebreaker) {
                const fighter1Id = this.competitors[fight.fighter1Index]?.id;
                const fighter2Id = this.competitors[fight.fighter2Index]?.id;
                if (competitorIds.includes(fighter1Id) && competitorIds.includes(fighter2Id)) {
                    return false;
                }
            }
            return true;
        });

        for (let i = 0; i < bracket.competitors.length; i++) {
            for (let j = i + 1; j < bracket.competitors.length; j++) {
                const fighter1Index = this.competitors.findIndex(c => c.id === bracket.competitors[i].id);
                const fighter2Index = this.competitors.findIndex(c => c.id === bracket.competitors[j].id);
                this.fights.push({
                    fighter1Index,
                    fighter2Index,
                    bracket: bracketId,
                    completed: false,
                    result: null,
                    judgeVotes: {
                        judge1: null,
                        judge2: null,
                        judge3: null,
                        judge4: null
                    }
                });
            }
        }

        bracket.completed = false;
        bracket.winner = null;
        this.groupWinners = this.groupWinners.filter(id => !competitorIds.includes(id));

        this.currentFightIndex = this.fights.findIndex(fight => !fight.completed);
        if (this.currentFightIndex === -1) {
            this.currentFightIndex = this.fights.length > 0 ? this.fights.length - 1 : 0;
        }

        this.updateScheduleDisplay();
        this.updateBracketsDisplay();
        this.saveToLocalStorage();
        if (this.fights.length > 0) {
            this.loadCurrentFight();
        }

        const bracketInfo = this.brackets.find(b => b.id === bracketId);
        alert(`🔁 ${bracketInfo ? bracketInfo.name : 'Llave'} reiniciada por empate múltiple. Se reprogramaron todas sus peleas.`);
    }

    resolveBracketIfComplete(bracketId) {
        console.log(`🔧 Evaluando si llave ${bracketId} está completa...`);
        
        if (this.currentPhase !== 'groups') {
            console.log('❌ No estamos en fase de grupos, saliendo');
            return;
        }

        const bracket = this.brackets.find(b => b.id === bracketId);
        if (!bracket) {
            console.log(`❌ Llave ${bracketId} no encontrada`);
            return;
        }

        const pendingNonTiebreaker = this.fights.some(fight =>
            fight.bracket === bracketId && !fight.isTiebreaker && !fight.completed
        );
        
        console.log(`📊 Estado de ${bracket.name}:`, {
            pendingNonTiebreaker,
            totalFights: this.fights.filter(f => f.bracket === bracketId).length,
            completedFights: this.fights.filter(f => f.bracket === bracketId && f.completed).length
        });
        
        if (pendingNonTiebreaker) {
            console.log(`⏳ ${bracket.name} aún tiene peleas normales pendientes`);
            return;
        }

        console.log(`✅ ${bracket.name} completada - todas las peleas normales finalizadas`);

        bracket.competitors.sort((a, b) => this.compareBracketCompetitors(a, b));

        const leader = bracket.competitors[0];
        const tiedGroup = bracket.competitors.filter(competitor =>
            this.haveSameBracketMetrics(competitor, leader)
        );

        console.log(`🏆 Análisis de ganadores en ${bracket.name}:`, {
            leader: leader.name,
            tiedGroup: tiedGroup.map(c => c.name),
            tiedGroupSize: tiedGroup.length
        });

        if (tiedGroup.length === bracket.competitors.length && bracket.competitors.length > 1) {
            console.log(`🔄 EMPATE TOTAL en ${bracket.name} - reiniciando llave`);
            bracket.completed = false;
            bracket.winner = null;
            this.restartBracket(bracketId);
            return;
        }

        if (tiedGroup.length > 1) {
            console.log(`⚡ EMPATE PARCIAL en ${bracket.name} - programando desempate`);
            bracket.completed = false;
            bracket.winner = null;
            if (tiedGroup.length === 2) {
                this.scheduleBracketTiebreaker(bracketId, tiedGroup[0], tiedGroup[1]);
            } else {
                this.restartBracket(bracketId);
            }
            return;
        }

        console.log(`🎯 ${bracket.name} RESUELTA - Ganador: ${leader.name}`);
        bracket.completed = true;
        bracket.winner = leader;

        const competitorIds = bracket.competitors.map(c => c.id);
        this.groupWinners = this.groupWinners.filter(id => !competitorIds.includes(id));
        if (!this.groupWinners.includes(leader.id)) {
            this.groupWinners.push(leader.id);
        }

        console.log(`📈 Ganadores actuales:`, this.groupWinners.map(id => {
            const competitor = this.competitors.find(c => c.id === id);
            return competitor ? competitor.name : `ID:${id}`;
        }));

        if (this.groupWinners.length === this.brackets.length && this.checkGroupStageComplete()) {
            console.log(`🏁 TODAS LAS LLAVES COMPLETADAS - Preparando para fase final`);
            document.getElementById('current-phase').textContent = 'Fase de Grupos Completada';
            document.getElementById('next-phase').style.display = 'block';
        } else {
            console.log(`⏳ Esperando más llaves: ${this.groupWinners.length}/${this.brackets.length} completadas`);
        }
    }

    generateFinalFight() {
        if (this.groupWinners.length !== 2) return;
        
        const fighter1Index = this.competitors.findIndex(c => c.id === this.groupWinners[0]);
        const fighter2Index = this.competitors.findIndex(c => c.id === this.groupWinners[1]);
        
        this.fights.push({
            fighter1Index: fighter1Index,
            fighter2Index: fighter2Index,
            bracket: null, // No pertenece a ninguna llave
            isFinal: true,
            completed: false,
            result: null,
            judgeVotes: {
                judge1: null,
                judge2: null,
                judge3: null,
                judge4: null
            }
        });
        
        // Actualizar currentFightIndex para apuntar a la pelea final
        this.currentFightIndex = this.fights.length - 1;
    }

    findNextAvailableFight() {
        // Función que busca la próxima pelea disponible cuando una llave se completa o tiene empates pendientes
        console.log('🔍 Buscando próxima pelea disponible...');
        console.log('📊 Estado actual:', {
            currentFightIndex: this.currentFightIndex,
            totalFights: this.fights.length,
            currentPhase: this.currentPhase,
            competitorCount: this.competitorCount
        });
        
        // Para sistema de brackets, mostrar estado de cada llave
        if (this.competitorCount > 5 && this.brackets.length > 0) {
            console.log('🏗️ Estado de las llaves:');
            this.brackets.forEach(bracket => {
                const bracketFights = this.fights.filter(f => f.bracket === bracket.id);
                const completedBracketFights = bracketFights.filter(f => f.completed);
                console.log(`   ${bracket.name}: ${completedBracketFights.length}/${bracketFights.length} peleas completadas`);
                
                // Mostrar peleas específicas
                bracketFights.forEach((fight, index) => {
                    const f1 = this.competitors[fight.fighter1Index];
                    const f2 = this.competitors[fight.fighter2Index];
                    console.log(`     Pelea ${index + 1}: ${f1?.name} vs ${f2?.name} - ${fight.completed ? 'Completada' : 'PENDIENTE'}`);
                });
            });
        }
        
        // BUSQUEDA AGRESIVA: Buscar cualquier pelea no completada en todo el array
        console.log('🎯 Buscando CUALQUIER pelea no completada...');
        let nextFightIndex = -1;
        
        // Buscar desde el principio
        for (let i = 0; i < this.fights.length; i++) {
            if (!this.fights[i].completed) {
                nextFightIndex = i;
                console.log(`🔍 Encontrada pelea pendiente en posición ${i}`);
                break;
            }
        }
        
        // Si encontramos una pelea disponible
        if (nextFightIndex !== -1) {
            const nextFight = this.fights[nextFightIndex];
            const bracket = this.brackets.find(b => b.id === nextFight.bracket);
            console.log(`✅ CAMBIANDO A PELEA: índice ${nextFightIndex} en ${bracket ? bracket.name : 'Sin llave'}`);
            this.currentFightIndex = nextFightIndex;
            this.loadCurrentFight();
            return true;
        }
        
        console.log('ℹ️ No hay más peleas disponibles en esta fase');
        return false;
    }

    checkAndGenerateFinalIfReady() {
        // Verificar si todas las llaves están completas
        if (!this.checkGroupStageComplete()) {
            return false; // Aún hay peleas pendientes
        }

        // Determinar ganadores de llaves
        const winnersReady = this.determineGroupWinners();
        if (!winnersReady) {
            console.log('Los ganadores de llaves aún no están determinados');
            return false; // Aún hay empates por resolver
        }

        // Si llegamos aquí, tenemos ganadores listos para la final
        console.log('Generando pelea final automáticamente...');
        this.generateFinalFight();
        this.currentPhase = 'final';
        document.getElementById('current-phase').textContent = 'FINAL';
        document.getElementById('next-phase').style.display = 'none';
        
        // Actualizar displays
        this.updateBracketsDisplay();
        this.updateScheduleDisplay();
        
        // IMPORTANTE: Cargar la pelea final recién creada
        this.loadCurrentFight();
        
        // Mostrar mensaje de transición
        const fighter1 = this.competitors[this.fights[this.currentFightIndex].fighter1Index];
        const fighter2 = this.competitors[this.fights[this.currentFightIndex].fighter2Index];
        
        alert(`🏆 FASE DE GRUPOS COMPLETADA 🏆\n\n` +
              `Ganadores de llaves determinados.\n\n` +
              `PELEA FINAL:\n${fighter1.name} vs ${fighter2.name}\n\n` +
              `¡Que comience la final!`);
        
        return true; // Se generó la pelea final
    }

    nextPhase() {
        if (this.currentPhase === 'groups') {
            if (this.checkGroupStageComplete()) {
                const winnersReady = this.determineGroupWinners();
                if (!winnersReady) {
                    this.updateBracketsDisplay();
                    this.updateScheduleDisplay();
                    return;
                }
                this.generateFinalFight();
                this.currentPhase = 'final';
                document.getElementById('current-phase').textContent = 'FINAL';
                document.getElementById('next-phase').style.display = 'none';
                // Asegurar que la sección de peleas esté visible para la final
                document.getElementById('fight-section').style.display = 'block';
                this.updateBracketsDisplay();
                this.loadCurrentFight();
            } else {
                alert('Debe completar todas las peleas de la fase de grupos primero.');
            }
        }
    }

    // Función de auto-guardado local solamente
    saveToLocalStorage() {
        const tournamentData = {
            competitors: this.competitors,
            fights: this.fights,
            currentFightIndex: this.currentFightIndex,
            categoryInfo: this.categoryInfo,
            competitorCount: this.competitorCount,
            brackets: this.brackets,
            currentPhase: this.currentPhase,
            groupWinners: this.groupWinners,
            timestamp: new Date().toISOString()
        };
        
        localStorage.setItem('taekwondo_tournament', JSON.stringify(tournamentData));
        console.log('✅ Torneo guardado automáticamente');
    }

    createBackupCopy() {
        try {
            // Crear backup con timestamp
            const backupKey = `taekwondo_backup_${Date.now()}`;
            const mainData = localStorage.getItem('taekwondo_tournament');
            if (mainData) {
                localStorage.setItem(backupKey, mainData);
                console.log('🔒 Backup de seguridad creado');
                
                // Mantener solo los 3 backups más recientes
                this.cleanOldBackups();
            }
        } catch (error) {
            console.warn('⚠️ No se pudo crear backup:', error);
        }
    }

    cleanOldBackups() {
        try {
            const keys = Object.keys(localStorage);
            const backupKeys = keys.filter(key => key.startsWith('taekwondo_backup_'))
                                 .sort((a, b) => b.localeCompare(a)); // Más recientes primero
            
            // Eliminar backups antiguos, mantener solo 3
            backupKeys.slice(3).forEach(key => {
                localStorage.removeItem(key);
            });
        } catch (error) {
            console.warn('⚠️ Error limpiando backups antiguos:', error);
        }
    }

    loadFromLocalStorage() {
        const saved = localStorage.getItem('taekwondo_tournament');
        if (saved) {
            try {
                const data = JSON.parse(saved);
                
                // Mostrar opción de continuar torneo guardado
                if (data.competitors && data.competitors.length > 0) {
                    const continueMsg = `🔄 RECUPERAR TORNEO GUARDADO\n\n` +
                        `Se encontró un torneo guardado automáticamente:\n\n` +
                        `📋 Categoría: ${data.categoryInfo.gender} ${data.categoryInfo.ageFrom}-${data.categoryInfo.ageTo} años\n` +
                        `🥋 Cinturones: ${data.categoryInfo.beltCategory}\n` +
                        `⚖️ Peso: ${data.categoryInfo.weightCategory}\n` +
                        `👥 Competidores: ${data.competitors.length}\n` +
                        `📅 Guardado: ${new Date(data.timestamp).toLocaleDateString('es-ES')} ${new Date(data.timestamp).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}\n\n` +
                        `¿Deseas continuar este torneo?`;
                    
                    if (confirm(continueMsg)) {
                        this.restoreFromData(data);
                        alert('✅ Torneo recuperado exitosamente!');
                        return true;
                    } else {
                        // Si no quiere continuar, limpiar datos guardados
                        localStorage.removeItem('taekwondo_tournament');
                    }
                }
            } catch (e) {
                console.log('Error cargando datos guardados:', e);
                localStorage.removeItem('taekwondo_tournament');
            }
        }
        return false;
    }

    restoreFromData(data) {
        this.competitors = data.competitors || [];
        this.fights = data.fights || [];
        this.currentFightIndex = data.currentFightIndex || 0;
        this.categoryInfo = data.categoryInfo || {};
        this.competitorCount = data.competitorCount || 5;
        this.brackets = data.brackets || [];
        this.currentPhase = data.currentPhase || 'setup';
        this.groupWinners = data.groupWinners || [];

        // Restaurar fechas de las peleas
        this.fights.forEach(fight => {
            if (fight.completedAt) {
                fight.completedAt = new Date(fight.completedAt);
            }
        });

        // Mostrar la vista correcta según el estado
        if (this.competitors.length > 0) {
            if (this.competitorCount >= 6) {
                this.showBracketsSection();
            } else {
                this.showFightSection();
            }
            this.updateStandings();
            this.updateScheduleDisplay();
            this.updateFightHistory();
            if (this.currentFightIndex < this.fights.length) {
                this.loadCurrentFight();
            }
        }
    }

    // ========== FUNCIONES DEL CRONÓMETRO ==========
    
    initializeTimer() {
        this.updateTimerDisplay();
        this.showTimer();
        this.initializePenalties();
        
        // Mostrar sección de penalizaciones cuando se inicia el timer
        document.getElementById('penalties-section').style.display = 'block';
    }
    
    showTimer() {
        document.getElementById('floating-timer').style.display = 'block';
    }
    
    hideTimer() {
        document.getElementById('floating-timer').style.display = 'none';
    }
    
    startTimer() {
        if (!this.timer.isRunning) {
            this.timer.isRunning = true;
            
            // Usar try-catch para máxima seguridad
            try {
                this.timer.intervalId = setInterval(() => {
                    this.timer.seconds--;
                    this.updateTimerDisplay();
                    this.checkTimerWarnings();
                    
                    if (this.timer.seconds <= 0) {
                        this.stopTimer();
                        this.onTimerFinished();
                    }
                }, 1000);
                
                // Actualizar botones de forma segura
                const startBtn = document.getElementById('timer-start');
                const pauseBtn = document.getElementById('timer-pause');
                if (startBtn) startBtn.style.display = 'none';
                if (pauseBtn) pauseBtn.style.display = 'inline-block';
            } catch (e) {
                console.error('Error en cronómetro:', e);
                this.timer.isRunning = false;
            }
        }
    }
    
    pauseTimer() {
        if (this.timer.isRunning) {
            this.timer.isRunning = false;
            
            try {
                if (this.timer.intervalId) {
                    clearInterval(this.timer.intervalId);
                    this.timer.intervalId = null;
                }
                
                // Actualizar botones de forma segura
                const startBtn = document.getElementById('timer-start');
                const pauseBtn = document.getElementById('timer-pause');
                if (startBtn) startBtn.style.display = 'inline-block';
                if (pauseBtn) pauseBtn.style.display = 'none';
            } catch (e) {
                console.error('Error pausando cronómetro:', e);
            }
        }
    }
    
    resetTimer() {
        this.pauseTimer();
        this.timer.seconds = this.timer.originalSeconds;
        this.updateTimerDisplay();
        this.clearTimerWarnings();
    }
    
    stopTimer() {
        this.pauseTimer();
        // Finalizar sin confirmación para evitar interrupciones
        this.onTimerFinished();
    }
    
    onTimerFinished() {
        console.log('TIEMPO FINALIZADO');
        // Solo log - sin alertas que puedan interrumpir
    }
    
    clearTimerWarnings() {
        const timerDisplay = document.getElementById('timer-display');
        if (timerDisplay) {
            timerDisplay.className = 'timer-display';
        }
    }
    
    setTimerDuration(minutes) {
        const seconds = Math.floor(parseFloat(minutes) * 60);
        this.timer.originalSeconds = seconds;
        this.timer.seconds = seconds;
        this.updateTimerDisplay();
    }
    
    updateTimerDisplay() {
        const minutes = Math.floor(this.timer.seconds / 60);
        const seconds = this.timer.seconds % 60;
        const display = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        
        const timerDisplay = document.getElementById('timer-display');
        if (timerDisplay) {
            timerDisplay.textContent = display;
            
            // Cambiar colores según el tiempo restante - SIMPLE Y SEGURO
            timerDisplay.className = 'timer-display';
            if (this.timer.seconds <= 10) {
                timerDisplay.classList.add('danger');
            } else if (this.timer.seconds <= 30) {
                timerDisplay.classList.add('warning');
            }
        }
    }
    
    checkTimerWarnings() {
        // Solo avisos simples - sin sobrecargar el sistema
        if (!this.categoryInfo.timerWarnings) return;
        
        if (this.timer.seconds === 30) {
            console.log('30 segundos restantes');
        } else if (this.timer.seconds === 10) {
            console.log('10 segundos restantes');
            // Solo cambio de color, sin animaciones pesadas
        }
    }
    
    showTimerAlert(message, type) {
        // Crear notificación temporal
        const alert = document.createElement('div');
        alert.className = `timer-alert timer-alert-${type}`;
        alert.textContent = message;
        alert.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: ${type === 'danger' ? '#e74c3c' : '#f39c12'};
            color: white;
            padding: 20px 40px;
            border-radius: 10px;
            font-size: 1.5rem;
            font-weight: bold;
            z-index: 2000;
            box-shadow: 0 4px 20px rgba(0,0,0,0.3);
            animation: alertPulse 0.5s ease-in-out;
        `;
        
        document.body.appendChild(alert);
        
        // Reproducir sonido si es posible
        this.playTimerSound(type);
        
        // Remover después de 2 segundos
        setTimeout(() => {
            if (alert.parentNode) {
                alert.parentNode.removeChild(alert);
            }
        }, 2000);
    }
    
    playTimerSound(type) {
        // Crear audio context para sonidos
        try {
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const oscillator = audioContext.createOscillator();
            const gainNode = audioContext.createGain();
            
            oscillator.connect(gainNode);
            gainNode.connect(audioContext.destination);
            
            oscillator.frequency.value = type === 'danger' ? 800 : 600;
            oscillator.type = 'square';
            
            gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);
            
            oscillator.start(audioContext.currentTime);
            oscillator.stop(audioContext.currentTime + 0.5);
        } catch (e) {
            console.log('Audio no disponible');
        }
    }
    
    clearTimerWarnings() {
        const timerDisplay = document.getElementById('timer-display');
        timerDisplay.className = 'timer-display';
    }
    
    onTimerFinished() {
        this.showTimerAlert('🔚 TIEMPO FINALIZADO', 'danger');
        // Opcional: avanzar automáticamente o requerir confirmación manual
    }
    
    toggleTimerMinimize() {
        const timer = document.getElementById('floating-timer');
        const button = document.getElementById('timer-minimize');
        
        this.timer.isMinimized = !this.timer.isMinimized;
        
        if (this.timer.isMinimized) {
            timer.classList.add('minimized');
            button.textContent = '+';
        } else {
            timer.classList.remove('minimized');
            button.textContent = '−';
        }
    }
    
    makeTimerDraggable() {
        const timer = document.getElementById('floating-timer');
        const header = timer.querySelector('.timer-header');
        let isDragging = false;
        let startX, startY, initialX, initialY;
        
        header.addEventListener('mousedown', (e) => {
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            initialX = timer.offsetLeft;
            initialY = timer.offsetTop;
            header.style.cursor = 'grabbing';
        });
        
        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            
            const deltaX = e.clientX - startX;
            const deltaY = e.clientY - startY;
            
            timer.style.left = `${initialX + deltaX}px`;
            timer.style.top = `${initialY + deltaY}px`;
            timer.style.right = 'auto';
        });
        
        document.addEventListener('mouseup', () => {
            isDragging = false;
            header.style.cursor = 'move';
        });
    }

    // ========== SISTEMA DE PENALIZACIONES ==========
    
    initializePenalties() {
        this.penalties = {
            red: { warnings: 0, penalties: 0 },
            blue: { warnings: 0, penalties: 0 }
        };
        this.updatePenaltiesDisplay();
    }

    updateCompetitorNames(fighter1Name, fighter2Name) {
        document.getElementById('blue-competitor-name').textContent = fighter1Name;
        document.getElementById('red-competitor-name').textContent = fighter2Name;
    }

    updatePenaltiesDisplay() {
        // Actualizar display de advertencias y penalizaciones
        document.getElementById('red-warnings').textContent = this.penalties.red.warnings;
        document.getElementById('red-penalties').textContent = this.penalties.red.penalties;
        document.getElementById('blue-warnings').textContent = this.penalties.blue.warnings;
        document.getElementById('blue-penalties').textContent = this.penalties.blue.penalties;
        
        // Calcular total de puntos en contra (cada 3 advertencias = 1 punto)
        const redTotal = Math.floor(this.penalties.red.warnings / 3) + this.penalties.red.penalties;
        const blueTotal = Math.floor(this.penalties.blue.warnings / 3) + this.penalties.blue.penalties;
        
        // Actualizar display de totales
        document.getElementById('red-total').textContent = redTotal;
        document.getElementById('blue-total').textContent = blueTotal;
    }

    resetPenalties() {
        this.penalties = {
            red: { warnings: 0, penalties: 0 },
            blue: { warnings: 0, penalties: 0 }
        };
        this.updatePenaltiesDisplay();
    }

    getPenaltiesForResult() {
        return {
            red: `${this.penalties.red.warnings} adv, ${this.penalties.red.penalties} pts-`,
            blue: `${this.penalties.blue.warnings} adv, ${this.penalties.blue.penalties} pts-`
        };
    }
}

// Funciones globales para los botones de penalizaciones
function adjustWarnings(color, delta) {
    if (tournament && tournament.penalties) {
        tournament.penalties[color].warnings = Math.max(0, tournament.penalties[color].warnings + delta);
        tournament.updatePenaltiesDisplay();
    }
}

function adjustPenalties(color, delta) {
    if (tournament && tournament.penalties) {
        tournament.penalties[color].penalties = Math.max(0, tournament.penalties[color].penalties + delta);
        tournament.updatePenaltiesDisplay();
    }
}

function confirmResetPenalties() {
    if (confirm('¿Estás seguro de que quieres limpiar todas las penalizaciones y advertencias?')) {
        if (tournament && tournament.resetPenalties) {
            tournament.resetPenalties();
        }
    }
}

// Inicializar la aplicación cuando se carga la página
document.addEventListener('DOMContentLoaded', function() {
    tournament = new RoundRobinTournament();
});

// Funcionalidad adicional para cerrar modal al hacer clic fuera
window.addEventListener('click', function(event) {
    const modal = document.getElementById('tournament-result-modal');
    if (event.target === modal) {
        modal.style.display = 'none';
    }
});

// Variable tournament ya declarada al inicio del archivo

// ── Scoring en tiempo real — funciones de socket ──────────────────────────

function setScoringMode(mode) {
    if (mode === 'live' && !scoringConnected) {
        alert('⚠️ Servidor de scoring no disponible.\n\nIniciá el servidor primero:\n  npm run server\n  (en la carpeta tkd-scoring-starter-pro)\n\nLuego reintentá.');
        return;
    }
    scoringMode = mode;

    const btnManual = document.getElementById('mode-btn-manual');
    const btnLive   = document.getElementById('mode-btn-live');
    const livePanel = document.getElementById('live-scoring-panel');
    const judgesPanel = document.querySelector('.judges-panel');

    if (btnManual) btnManual.classList.toggle('active', mode === 'manual');
    if (btnLive)   btnLive.classList.toggle('active',   mode === 'live');
    if (livePanel)   livePanel.style.display   = mode === 'live' ? 'block' : 'none';
    if (judgesPanel) judgesPanel.style.display = mode === 'live' ? 'none'  : 'block';

    // Si hay combate activo y se cambió a live, cargar el match en el servidor
    if (mode === 'live' && scoringConnected && tournament && tournament.fights.length > 0) {
        const idx = tournament.currentFightIndex;
        const fight = tournament.fights[idx];
        if (fight && !fight.completed) {
            const f1 = tournament.competitors[fight.fighter1Index];
            const f2 = tournament.competitors[fight.fighter2Index];
            if (f1 && f2) {
                const rules = Object.assign({}, DEFAULT_SCORING_RULES, {
                    rounds: Object.assign({}, DEFAULT_SCORING_RULES.rounds, {
                        duration_seconds: (tournament.categoryInfo && tournament.categoryInfo.fightDuration) || 120
                    })
                });
                scoringSocket.emit('match:load', {
                    rules,
                    match: { id: 'fight-' + idx, ringId: 'ring-1',
                             red:  { id: String(f1.id), name: f1.name },
                             blue: { id: String(f2.id), name: f2.name } }
                });
                updateScoringPanelNames(f1.name, f2.name);
            }
        }
    }
}

function updateScoringPanelNames(redName, blueName) {
    const r = document.getElementById('live-red-name');
    const b = document.getElementById('live-blue-name');
    if (r) r.textContent = redName;
    if (b) b.textContent = blueName;
}

function updateConnectionStatusUI() {
    const statusEl = document.getElementById('server-status');
    const textEl   = document.getElementById('server-status-text');
    const btnLive  = document.getElementById('mode-btn-live');
    if (!statusEl) return;
    if (scoringConnected) {
        statusEl.className = 'server-status server-online';
        if (textEl) textEl.textContent = 'Servidor disponible';
        if (btnLive) btnLive.title = '';
    } else {
        statusEl.className = 'server-status server-offline';
        if (textEl) textEl.textContent = 'Sin servidor';
        if (btnLive) btnLive.title = 'Servidor no disponible';
        // Si estaba en modo live y se desconectó, volver a manual pero no forzar
        if (scoringMode === 'live') {
            const judgesPanel = document.querySelector('.judges-panel');
            const livePanel   = document.getElementById('live-scoring-panel');
            if (judgesPanel) judgesPanel.style.display = 'block';
            if (livePanel)   livePanel.style.display   = 'none';
        }
    }
}

function updateLiveScoringUI(data) {
    liveScoringLastData = data;
    if (!data || !data.matchState) return;
    const ms = data.matchState;

    // Sumar puntajes totales de todos los rounds
    let redTotal = 0, blueTotal = 0;
    if (ms.rounds) {
        ms.rounds.forEach(function(r) {
            if (r.totals) { redTotal += r.totals.red || 0; blueTotal += r.totals.blue || 0; }
        });
    }

    const PHASE_LABELS = {
        idle: '—', round: 'Round', rest: 'Descanso',
        overtime: 'Prórroga', golden_point: '★ Oro',
        penalties: 'Penalidades', finished: 'Fin'
    };

    const phaseEl  = document.getElementById('live-phase');
    const timerEl  = document.getElementById('live-timer');
    const redEl    = document.getElementById('live-red-score');
    const blueEl   = document.getElementById('live-blue-score');
    const judgeEl  = document.getElementById('live-judge-count');
    const qrGrid   = document.getElementById('judge-qr-grid');

    if (redEl)   redEl.textContent  = redTotal;
    if (blueEl)  blueEl.textContent = blueTotal;
    if (phaseEl) {
        var phaseTxt = PHASE_LABELS[ms.phase] || ms.phase;
        phaseEl.textContent = (data.matchPaused && (ms.phase === 'round' || ms.phase === 'overtime')) ? phaseTxt + ' ⏸' : phaseTxt;
    }

    if (timerEl) {
        if (ms.phase === 'round' || ms.phase === 'overtime' || ms.phase === 'rest') {
            const m = Math.floor(ms.timeLeft / 60).toString().padStart(2, '0');
            const s = (ms.timeLeft % 60).toString().padStart(2, '0');
            timerEl.textContent = m + ':' + s;
        } else {
            timerEl.textContent = '—';
        }
    }

    // ── Advertencias y Faltas ─────────────────────────────
    var pc = data.penaltyCounts;
    if (pc) {
        var wr = document.getElementById('warn-red');
        var wb = document.getElementById('warn-blue');
        var fr = document.getElementById('foul-red');
        var fb = document.getElementById('foul-blue');
        if (wr) wr.textContent = pc.warnings.red;
        if (wb) wb.textContent = pc.warnings.blue;
        if (fr) fr.textContent = pc.fouls.red;
        if (fb) fb.textContent = pc.fouls.blue;
    }

    if (judgeEl) {
        const count = (data.judges && data.judges.length) || 0;
        judgeEl.textContent = count + ' juez' + (count !== 1 ? 'ces' : '') + ' conectado' + (count !== 1 ? 's' : '');
    }

    if (qrGrid && data.serverUrl) {
        const base = 'http://localhost:3001/qr/';
        for (var jn = 1; jn <= 4; jn++) {
            var img = document.getElementById('qr-judge-' + jn);
            if (img && !img.src.includes('/qr/')) {
                img.src = base + jn;
            }
        }
        qrGrid.style.display = 'flex';
    }

    // ── Cards de jueces (2×2) ───────────────────────────────
    var cardsGrid = document.getElementById('judge-cards-grid');
    var jt = data.judgeTotals;
    if (cardsGrid && jt) {
        var hasAny = Object.keys(jt).length > 0;
        cardsGrid.style.display = hasAny ? 'grid' : 'none';
        for (var n = 1; n <= 4; n++) {
            var jid = 'J' + n;
            var entry = jt[jid] || { red: 0, blue: 0, redFav: 0, blueFav: 0, redContra: 0, blueContra: 0 };
            var isConn = data.judges && data.judges.includes(jid);
            var card = document.getElementById('jcard-' + jid);
            if (card) {
                card.classList.toggle('connected', !!isConn);
            }
            var setVal = function(elId, val) { var el = document.getElementById(elId); if (el) el.textContent = val; };
            setVal('jc' + n + '-red-fav',    entry.redFav || 0);
            setVal('jc' + n + '-blue-fav',   entry.blueFav || 0);
            setVal('jc' + n + '-red-contra',  entry.redContra || 0);
            setVal('jc' + n + '-blue-contra', entry.blueContra || 0);
            setVal('jc' + n + '-red-tot',    entry.red);
            setVal('jc' + n + '-blue-tot',   entry.blue);
        }
    }

    // ── Fallos log ──────────────────────────────────────────
    var fallosSection = document.getElementById('fallos-section');
    var fallosBody    = document.getElementById('fallos-body');
    if (fallosSection && fallosBody && data.fallos) {
        fallosSection.style.display = 'block';
        if (data.fallos.length === 0) {
            fallosBody.innerHTML = '<tr class="fallos-empty-row"><td colspan="5">Sin registros aún</td></tr>';
        } else {
            var fHtml = '';
            for (var i = data.fallos.length - 1; i >= 0; i--) {
                var f = data.fallos[i];
                var falloNum = i + 1;
                var scoreClass = f.winner === 'red' || f.winner === 'red-dq' ? 'red-wins' :
                                 f.winner === 'blue' || f.winner === 'blue-dq' ? 'blue-wins' : 'draw';
                var scoreStr = f.redScore + ' - ' + f.blueScore;
                if (f.winner === 'red-dq')  scoreStr += ' (DQ ROJO)';
                if (f.winner === 'blue-dq') scoreStr += ' (DQ AZUL)';
                var fId = f.id;
                fHtml += '<tr>';
                fHtml += '<td>' + falloNum + '</td>';
                fHtml += '<td>' + f.time + '</td>';
                fHtml += '<td>' + f.redName + ' vs ' + f.blueName + '</td>';
                fHtml += '<td><span class="fallos-score ' + scoreClass + '">' + scoreStr + '</span></td>';
                fHtml += '<td><button class="fallos-del-btn" onclick="deleteFallo(' + fId + ')">🗑</button></td>';
                fHtml += '</tr>';
            }
            fallosBody.innerHTML = fHtml;
        }
    }

    // Si el combate terminó, notificar al torneo
    if (ms.phase === 'finished' && ms.result && ms.result.winner) {
        if (tournament) tournament.setWinnerFromScoring(ms.result.winner, redTotal, blueTotal);
    }
}

function initScoringConnection() {
    if (typeof io === 'undefined') {
        console.warn('Socket.IO no disponible — modo manual solamente.');
        return;
    }
    scoringSocket = io('http://localhost:3001', {
        reconnectionAttempts: 20,
        reconnectionDelay: 3000,
        timeout: 5000
    });
    scoringSocket.on('connect', function() {
        scoringConnected = true;
        updateConnectionStatusUI();
    });
    scoringSocket.on('disconnect', function() {
        scoringConnected = false;
        updateConnectionStatusUI();
    });
    scoringSocket.on('state:update', function(data) {
        updateLiveScoringUI(data);
        // Sincronizar estado del botón Iniciar/Finalizar/Detener/Continuar
        var ms = data && data.matchState;
        var paused = data && data.matchPaused;
        var btnStart  = document.getElementById('btn-start-fight');
        var btnFinish = document.getElementById('btn-finish-fight');
        var btnPause  = document.getElementById('btn-pause-fight');
        var btnResume = document.getElementById('btn-resume-fight');
        if (!ms) return;
        var active = ms.phase === 'round' || ms.phase === 'overtime' || ms.phase === 'golden_point';
        var idle   = ms.phase === 'idle' || ms.phase === 'rest' || ms.phase === 'finished';
        if (btnStart)  btnStart.style.display  = idle ? 'inline-flex' : 'none';
        if (btnStart)  btnStart.disabled = ms.phase === 'finished';
        if (btnFinish) btnFinish.style.display = (active && !paused) ? 'inline-flex' : 'none';
        if (btnPause)  btnPause.style.display  = (active && !paused) ? 'inline-flex' : 'none';
        if (btnResume) btnResume.style.display = (active && paused)  ? 'inline-flex' : 'none';
    });
}

function startLiveFight() {
    if (!scoringConnected || !scoringSocket) return;
    var connectedCount = (liveScoringLastData && liveScoringLastData.judges) ? liveScoringLastData.judges.length : 0;
    var requiredCount = 4;
    if (connectedCount < requiredCount) {
        var msg = '\u26a0\ufe0f Solo hay ' + connectedCount + ' de ' + requiredCount + ' jueces conectados.\n\u00bfIniciar combate de todas formas?';
        if (!confirm(msg)) return;
    }
    scoringSocket.emit('match:start');
    // Abrir pantalla TV en nueva pestaña
    window.open('http://localhost:3001/tv', '_blank');
}

function finishLiveFight() {
    if (!scoringConnected || !scoringSocket) return;
    scoringSocket.emit('match:finishRound');
}

function pauseLiveFight() {
    if (!scoringConnected || !scoringSocket) return;
    scoringSocket.emit('match:pause');
}

function resumeLiveFight() {
    if (!scoringConnected || !scoringSocket) return;
    scoringSocket.emit('match:resume');
}

function dqCompetitor(side) {
    if (!scoringConnected || !scoringSocket) return;
    var name = side === 'red'
        ? (document.getElementById('live-red-name') || {}).textContent || 'ROJO'
        : (document.getElementById('live-blue-name') || {}).textContent || 'AZUL';
    if (!confirm('¿Descalificar a ' + name + '?')) return;
    scoringSocket.emit('match:dq', { competitor: side });
}

function medicalTimeout() {
    if (!scoringConnected || !scoringSocket) return;
    scoringSocket.emit('match:medical', { competitor: 'red' }); // pausa el reloj
    alert('⏸ Tiempo médico — el reloj está pausado. Usa "Continuar" para reanudar.');
}

function deleteFallo(id) {
    if (!scoringConnected || !scoringSocket) return;
    scoringSocket.emit('match:deleteFallo', { id: id });
}

function clearFallos() {
    if (!scoringConnected || !scoringSocket) return;
    if (!confirm('¿Borrar todos los fallos registrados?')) return;
    scoringSocket.emit('match:clearFallos');
}

function addPenalty(competitor, type) {
    if (!scoringConnected || !scoringSocket) return;
    scoringSocket.emit('match:event', { judgeId: 'arbiter', competitor: competitor, type: type });
}

function sortearAtaque() {
    var winner = Math.random() < 0.5 ? 'red' : 'blue';
    var banner = document.getElementById('sorteo-banner');
    var text   = document.getElementById('sorteo-text');
    if (!banner || !text) return;
    var redName  = (document.getElementById('live-red-name') || {}).textContent || 'ROJO';
    var blueName = (document.getElementById('live-blue-name') || {}).textContent || 'AZUL';
    text.textContent = '...';
    text.className = 'sorteo-text';
    banner.style.display = 'flex';
    // Brief animation
    var flips = 0;
    var interval = setInterval(function() {
        flips++;
        text.textContent = flips % 2 === 0 ? redName : blueName;
        text.className = 'sorteo-text ' + (flips % 2 === 0 ? 'red' : 'blue');
        if (flips >= 8) {
            clearInterval(interval);
            text.textContent = (winner === 'red' ? redName : blueName) + ' ataca primero';
            text.className = 'sorteo-text ' + winner;
            setTimeout(function() { banner.style.display = 'none'; }, 3000);
        }
    }, 150);
}

// Intentar conectar al servidor de scoring al cargar la página
document.addEventListener('DOMContentLoaded', function() {
    initScoringConnection();
});
