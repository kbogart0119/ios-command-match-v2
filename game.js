const DEFAULT_GAME_MINUTES = 10;
const PAIRS_PER_ROUND = 5;

const DIFFICULTY_STAGES = [
  { minimumProgress: 0, label: 'Foundational' },
  { minimumProgress: 0.20, label: 'Developing' },
  { minimumProgress: 0.50, label: 'Intermediate' },
  { minimumProgress: 0.80, label: 'Advanced' }
];

const elements = {
  startScreen: document.getElementById('start-screen'),
  gameScreen: document.getElementById('game-screen'),
  resultsScreen: document.getElementById('results-screen'),
  startButton: document.getElementById('start-button'),
  restartButton: document.getElementById('restart-button'),
  durationSelect: document.getElementById('game-duration'),
  objectiveColumn: document.getElementById('objective-column'),
  commandColumn: document.getElementById('command-column'),
  timer: document.getElementById('timer'),
  score: document.getElementById('score'),
  incorrect: document.getElementById('incorrect'),
  accuracy: document.getElementById('accuracy'),
  difficultyLabel: document.getElementById('difficulty-label'),
  roundNumber: document.getElementById('round-number'),
  finalScore: document.getElementById('final-score'),
  finalIncorrect: document.getElementById('final-incorrect'),
  finalAccuracy: document.getElementById('final-accuracy'),
  finalRounds: document.getElementById('final-rounds'),
  feedback: document.getElementById('feedback')
};

let commandBank = [];
let questionBank = [];
let score = 0;
let incorrectAttempts = 0;
let selectedGameSeconds = DEFAULT_GAME_MINUTES * 60;
let timeRemaining = selectedGameSeconds;
let timerId = null;
let activeRound = [];
let shuffledQuestionBank = [];
let usedQuestionIds = new Set();
let roundLocked = false;
let roundNumber = 0;
let touchDrag = null;
let touchSelectedObjective = null;

async function loadGameData() {
  const [commandsResponse, questionsResponse] = await Promise.all([
    fetch('commands.json'),
    fetch('questions.json')
  ]);

  if (!commandsResponse.ok) throw new Error('Unable to load commands.json');
  if (!questionsResponse.ok) throw new Error('Unable to load questions.json');

  const [commands, questions] = await Promise.all([
    commandsResponse.json(),
    questionsResponse.json()
  ]);

  validateGameData(commands, questions);
  commandBank = commands;

  const commandsById = new Map(commands.map(command => [command.id, command]));
  questionBank = questions.map(question => {
    const commandRecord = commandsById.get(question.commandId);
    return {
      ...question,
      command: question.answerCommand || commandRecord.command,
      category: commandRecord.category,
      commandPurpose: commandRecord.purpose,
      commandSyntax: commandRecord.syntax,
      examWeight: commandRecord.examWeight
    };
  });
}

function validateGameData(commands, questions) {
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new Error('commands.json must contain command records.');
  }
  if (!Array.isArray(questions) || questions.length < PAIRS_PER_ROUND) {
    throw new Error(`questions.json must contain at least ${PAIRS_PER_ROUND} records.`);
  }

  const commandIds = new Set();
  commands.forEach((command, index) => {
    ['id', 'command', 'purpose', 'syntax', 'difficulty', 'category', 'examWeight'].forEach(field => {
      if (command[field] === undefined || command[field] === '') {
        throw new Error(`Command ${index + 1} is missing the required field: ${field}`);
      }
    });
    if (commandIds.has(command.id)) throw new Error(`Duplicate command ID: ${command.id}`);
    commandIds.add(command.id);
  });

  const questionIds = new Set();
  questions.forEach((question, index) => {
    ['id', 'commandId', 'difficulty', 'cognitiveLevel', 'scenario', 'objective', 'explanation', 'answerCommand'].forEach(field => {
      if (question[field] === undefined || question[field] === '') {
        throw new Error(`Question ${index + 1} is missing the required field: ${field}`);
      }
    });
    if (!commandIds.has(question.commandId)) {
      throw new Error(`Question ${question.id} references unknown command ID ${question.commandId}.`);
    }
    if (questionIds.has(question.id)) throw new Error(`Duplicate question ID: ${question.id}`);
    questionIds.add(question.id);
  });

}

function shuffle(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function getCurrentStage() {
  const elapsed = selectedGameSeconds - timeRemaining;
  const progress = selectedGameSeconds > 0 ? elapsed / selectedGameSeconds : 1;

  return [...DIFFICULTY_STAGES]
    .reverse()
    .find(stage => progress >= stage.minimumProgress) || DIFFICULTY_STAGES[0];
}

function buildRoundFromPool(pool) {
  const selected = [];
  const seenCommandIds = new Set();
  const seenDisplayedCommands = new Set();

  for (const question of pool) {
    const displayedCommand = question.answerCommand || question.command;
    if (seenCommandIds.has(question.commandId) || seenDisplayedCommands.has(displayedCommand)) continue;

    selected.push(question);
    seenCommandIds.add(question.commandId);
    seenDisplayedCommands.add(displayedCommand);

    if (selected.length === PAIRS_PER_ROUND) break;
  }

  return selected;
}

function selectRound() {
  const stage = getCurrentStage();
  const stageIndex = DIFFICULTY_STAGES.findIndex(item => item.label === stage.label);
  const allowedLabels = DIFFICULTY_STAGES.slice(0, stageIndex + 1).map(item => item.label);

  // Shuffle once at the beginning of each game, then preserve that random order
  // while favoring questions from the current difficulty stage.
  const unusedCurrentStage = shuffledQuestionBank.filter(question =>
    question.difficulty === stage.label &&
    !usedQuestionIds.has(question.id)
  );

  const unusedEarlierStages = shuffledQuestionBank.filter(question =>
    allowedLabels.includes(question.difficulty) &&
    question.difficulty !== stage.label &&
    !usedQuestionIds.has(question.id)
  );

  let selected = buildRoundFromPool([
    ...unusedCurrentStage,
    ...unusedEarlierStages
  ]);

  // If the usable pool is exhausted, begin a fresh shuffled cycle.
  if (selected.length < PAIRS_PER_ROUND) {
    usedQuestionIds.clear();
    shuffledQuestionBank = shuffle(questionBank);

    const refreshedCurrentStage = shuffledQuestionBank.filter(
      question => question.difficulty === stage.label
    );
    const refreshedEarlierStages = shuffledQuestionBank.filter(question =>
      allowedLabels.includes(question.difficulty) &&
      question.difficulty !== stage.label
    );

    selected = buildRoundFromPool([
      ...refreshedCurrentStage,
      ...refreshedEarlierStages
    ]);
  }

  activeRound = selected;
  activeRound.forEach(question => usedQuestionIds.add(question.id));
  elements.difficultyLabel.textContent = stage.label;
}

function commandsNotAligned(objectives, commands) {
  return objectives.every((objective, index) => objective.id !== commands[index].id);
}

function buildObjectiveTile(item) {
  const tile = document.createElement('div');
  tile.className = 'tile objective';
  tile.draggable = true;
  tile.tabIndex = 0;
  tile.dataset.pairId = item.id;
  tile.textContent = `${item.scenario} ${item.objective}`;
  tile.setAttribute('aria-label', `Objective: ${tile.textContent}`);
  tile.addEventListener('dragstart', handleDragStart);
  tile.addEventListener('dragend', handleDragEnd);
  tile.addEventListener('pointerdown', handlePointerDown);
  return tile;
}

function buildCommandTile(item) {
  const tile = document.createElement('div');
  tile.className = 'tile command';
  tile.dataset.pairId = item.id;
  tile.textContent = item.command;
  tile.setAttribute('aria-label', `IOS command: ${item.command}`);
  tile.addEventListener('dragover', handleDragOver);
  tile.addEventListener('dragleave', handleDragLeave);
  tile.addEventListener('drop', handleDrop);
  tile.addEventListener('click', handleTouchCommandTap);
  return tile;
}

function renderRound() {
  roundLocked = false;
  clearTouchSelection();
  elements.feedback.textContent = '';
  roundNumber += 1;
  elements.roundNumber.textContent = roundNumber;
  selectRound();

  const objectives = shuffle(activeRound);
  let commands = shuffle(activeRound);
  let attempts = 0;

  while (!commandsNotAligned(objectives, commands) && attempts < 100) {
    commands = shuffle(activeRound);
    attempts += 1;
  }

  elements.objectiveColumn.replaceChildren(...objectives.map(buildObjectiveTile));
  elements.commandColumn.replaceChildren(...commands.map(buildCommandTile));
}


function clearTouchSelection() {
  if (touchSelectedObjective) touchSelectedObjective.classList.remove('touch-selected');
  touchSelectedObjective = null;
}

function handlePointerDown(event) {
  if (roundLocked || event.pointerType === 'mouse') return;

  const objectiveTile = event.currentTarget;
  objectiveTile.setPointerCapture(event.pointerId);
  touchDrag = {
    pointerId: event.pointerId,
    objectiveTile,
    startX: event.clientX,
    startY: event.clientY,
    moved: false,
    ghost: null,
    overCommand: null
  };

  objectiveTile.addEventListener('pointermove', handlePointerMove);
  objectiveTile.addEventListener('pointerup', handlePointerUp);
  objectiveTile.addEventListener('pointercancel', handlePointerCancel);
}

function handlePointerMove(event) {
  if (!touchDrag || event.pointerId !== touchDrag.pointerId) return;
  const distance = Math.hypot(event.clientX - touchDrag.startX, event.clientY - touchDrag.startY);
  if (!touchDrag.moved && distance < 8) return;

  event.preventDefault();
  touchDrag.moved = true;

  if (!touchDrag.ghost) {
    const rect = touchDrag.objectiveTile.getBoundingClientRect();
    const ghost = touchDrag.objectiveTile.cloneNode(true);
    ghost.classList.add('touch-drag-ghost');
    ghost.style.width = `${rect.width}px`;
    document.body.appendChild(ghost);
    touchDrag.ghost = ghost;
    touchDrag.objectiveTile.classList.add('dragging');
  }

  touchDrag.ghost.style.left = `${event.clientX}px`;
  touchDrag.ghost.style.top = `${event.clientY}px`;

  const underneath = document.elementFromPoint(event.clientX, event.clientY);
  const commandTile = underneath ? underneath.closest('.command') : null;
  if (touchDrag.overCommand && touchDrag.overCommand !== commandTile) {
    touchDrag.overCommand.classList.remove('drag-over');
  }
  if (commandTile) commandTile.classList.add('drag-over');
  touchDrag.overCommand = commandTile;
}

function finishPointerInteraction(event, cancelled = false) {
  if (!touchDrag || event.pointerId !== touchDrag.pointerId) return;
  const { objectiveTile, moved, ghost, overCommand } = touchDrag;

  objectiveTile.removeEventListener('pointermove', handlePointerMove);
  objectiveTile.removeEventListener('pointerup', handlePointerUp);
  objectiveTile.removeEventListener('pointercancel', handlePointerCancel);
  objectiveTile.classList.remove('dragging');
  if (ghost) ghost.remove();
  if (overCommand) overCommand.classList.remove('drag-over');

  touchDrag = null;
  if (cancelled || roundLocked) return;

  if (moved) {
    clearTouchSelection();
    if (!overCommand) return;
    if (objectiveTile.dataset.pairId === overCommand.dataset.pairId) {
      processCorrectMatch(objectiveTile, overCommand);
    } else {
      processIncorrectMatch(objectiveTile, overCommand);
    }
    return;
  }

  clearTouchSelection();
  touchSelectedObjective = objectiveTile;
  objectiveTile.classList.add('touch-selected');
  elements.feedback.textContent = 'Objective selected. Tap the matching IOS command.';
}

function handlePointerUp(event) {
  finishPointerInteraction(event, false);
}

function handlePointerCancel(event) {
  finishPointerInteraction(event, true);
}

function handleTouchCommandTap(event) {
  if (!touchSelectedObjective || roundLocked) return;
  const commandTile = event.currentTarget;
  const objectiveTile = touchSelectedObjective;
  clearTouchSelection();

  if (objectiveTile.dataset.pairId === commandTile.dataset.pairId) {
    processCorrectMatch(objectiveTile, commandTile);
  } else {
    processIncorrectMatch(objectiveTile, commandTile);
  }
}

function handleDragStart(event) {
  if (roundLocked) {
    event.preventDefault();
    return;
  }
  event.dataTransfer.setData('text/plain', event.currentTarget.dataset.pairId);
  event.dataTransfer.effectAllowed = 'move';
  event.currentTarget.classList.add('dragging');
}

function handleDragEnd(event) {
  event.currentTarget.classList.remove('dragging');
  document.querySelectorAll('.command.drag-over').forEach(tile => tile.classList.remove('drag-over'));
}

function handleDragOver(event) {
  if (roundLocked) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  event.currentTarget.classList.add('drag-over');
}

function handleDragLeave(event) {
  event.currentTarget.classList.remove('drag-over');
}

function handleDrop(event) {
  event.preventDefault();
  if (roundLocked) return;

  const commandTile = event.currentTarget;
  commandTile.classList.remove('drag-over');
  const draggedId = event.dataTransfer.getData('text/plain');
  const objectiveTile = document.querySelector(`.objective[data-pair-id="${draggedId}"]`);
  if (!objectiveTile) return;

  if (draggedId === commandTile.dataset.pairId) {
    processCorrectMatch(objectiveTile, commandTile);
  } else {
    processIncorrectMatch(objectiveTile, commandTile);
  }
}

function processCorrectMatch(objectiveTile, commandTile) {
  score += 1;
  updateStatistics();
  elements.feedback.textContent = 'Correct';
  objectiveTile.classList.add('correct');
  commandTile.classList.add('correct');
  objectiveTile.draggable = false;

  setTimeout(() => {
    objectiveTile.remove();
    commandTile.remove();
    elements.feedback.textContent = '';
    if (!elements.objectiveColumn.children.length && timeRemaining > 0) renderRound();
  }, 1000);
}

function processIncorrectMatch(objectiveTile, commandTile) {
  incorrectAttempts += 1;
  updateStatistics();
  elements.feedback.textContent = 'That command does not best accomplish the stated objective.';
  commandTile.classList.add('incorrect');
  objectiveTile.classList.add('incorrect');

  setTimeout(() => {
    commandTile.classList.remove('incorrect');
    objectiveTile.classList.remove('incorrect');
    elements.feedback.textContent = '';
  }, 500);
}

function calculateAccuracy() {
  const attempts = score + incorrectAttempts;
  return attempts === 0 ? null : (score / attempts) * 100;
}

function formatAccuracy() {
  const accuracy = calculateAccuracy();
  return accuracy === null ? '—' : `${accuracy.toFixed(1)}%`;
}

function updateStatistics() {
  elements.score.textContent = score;
  elements.incorrect.textContent = incorrectAttempts;
  elements.accuracy.textContent = formatAccuracy();
}

function updateTimer() {
  const minutes = Math.floor(timeRemaining / 60);
  const seconds = timeRemaining % 60;
  elements.timer.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
  elements.difficultyLabel.textContent = getCurrentStage().label;
}

function startTimer() {
  clearInterval(timerId);
  timerId = setInterval(() => {
    timeRemaining -= 1;
    updateTimer();
    if (timeRemaining <= 0) endGame();
  }, 1000);
}

function resetGameState() {
  score = 0;
  incorrectAttempts = 0;
  selectedGameSeconds = Number(elements.durationSelect.value) * 60;
  timeRemaining = selectedGameSeconds;
  roundNumber = 0;
  usedQuestionIds.clear();
  shuffledQuestionBank = shuffle(questionBank);
  updateStatistics();
  updateTimer();
}

function startGame() {
  resetGameState();
  elements.startScreen.classList.add('hidden');
  elements.resultsScreen.classList.add('hidden');
  elements.gameScreen.classList.remove('hidden');
  renderRound();
  startTimer();
}

function endGame() {
  clearInterval(timerId);
  roundLocked = true;
  timeRemaining = 0;
  updateTimer();
  elements.gameScreen.classList.add('hidden');
  elements.resultsScreen.classList.remove('hidden');
  elements.finalScore.textContent = score;
  elements.finalIncorrect.textContent = incorrectAttempts;
  elements.finalAccuracy.textContent = formatAccuracy();
  elements.finalRounds.textContent = roundNumber;
}

elements.startButton.addEventListener('click', startGame);
elements.restartButton.addEventListener('click', startGame);

loadGameData().catch(error => {
  console.error(error);
  elements.startScreen.innerHTML = `
    <div class="start-copy">
      <p class="section-label">Unable to Start</p>
      <h2>The game data could not be loaded.</h2>
      <p>${error.message}</p>
      <p>Open this folder through the Visual Studio Code Live Server extension rather than double-clicking index.html.</p>
    </div>`;
});
