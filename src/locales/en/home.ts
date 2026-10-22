/** Home tab, Podcast tab and episodes: fills in with Task 3a. */
export const en = {
  // Home screen chrome
  'home.searchAccessibilityLabel': 'Search islands',
  'home.recordAccessibilityLabel': 'Record a new island',
  'home.notConfigured': 'Set EXPO_PUBLIC_SHADOW_API_URL and EXPO_PUBLIC_SHADOW_TOKEN in .env, then restart the dev server.',
  'home.serverUnreachable': 'Could not reach the server',
  'home.serverNoAnswer': 'The server did not answer.',

  // Sort row
  'home.sortNewest': 'Newest',
  'home.sortLeastPracticed': 'Least practiced',

  // Empty and error states
  'home.noIslandMatches': 'No island matches',
  'home.noIslandsYet': 'No islands yet. Record a minute about your day and one gets built from it.',

  // Island card
  'home.untitledIsland': 'Untitled island',
  'home.failed': 'Failed',
  'home.dueToday': 'Due today',
  'home.practiceNow': 'Practice now',
  // Base keys exist only so `t('home.lines', { count })` type-checks: the
  // plural suffix always wins at runtime once `count` is passed (see
  // `pluralSuffix` in `src/lib/i18n.ts`).
  'home.lines': '{count} lines',
  'home.lines_one': '{count} line',
  'home.lines_two': '{count} lines',
  'home.lines_other': '{count} lines',
  'home.minutes': '{count} min',
  'home.minutes_one': '{count} min',
  'home.minutes_two': '{count} min',
  'home.minutes_other': '{count} min',
  'home.keptUp': 'kept up {kept}/{total}',
  'home.complexitySimple': 'simple',
  'home.complexityComplex': 'complex',

  // Rename/delete sheet
  'home.deleteConfirmTitle': 'Delete "{title}"?',
  'home.deleteConfirmBody': 'The recording, its lines and their audio are removed. This cannot be undone.',
  'home.deleteFailedTitle': 'Could not delete',
  'home.renameFailedTitle': 'Could not rename',
  'home.save': 'Save',
  'home.rename': 'Rename',
  'home.download': 'Download',
  'home.downloading': 'Downloading {done} of {total}',
  'home.downloaded': 'Downloaded · {size}',
  'home.downloadFailed': 'Download failed, tap to retry',
  'home.downloadStopTitle': 'Stop download?',
  'home.downloadKeepGoing': 'Keep going',
  'home.downloadStop': 'Stop',
  'home.downloadRemoveTitle': 'Remove download?',
  'home.downloadRemoveBody': 'The island stays on the server. Your takes on this phone are kept.',
  'home.downloadRemove': 'Remove',
  'home.deleteIsland': 'Delete island',

  // Practice card
  'home.drive': 'Drive',
  'home.practiceToday': 'Today',
  // A slash pair, not "1 of 10": the two figures read as one number, the way
  // a score does, and no word wedges between them. Same shape in Hebrew.
  'home.practiceGoal': '/{goal}',
  // Narrow weekday letters for the 7-day row, Sunday first. Hermes' Intl
  // answers `weekday: 'narrow'` with a Latin letter whatever locale it is
  // handed, so the letters are spelled out here instead.
  'home.weekdaySun': 'S',
  'home.weekdayMon': 'M',
  'home.weekdayTue': 'T',
  'home.weekdayWed': 'W',
  'home.weekdayThu': 'T',
  'home.weekdayFri': 'F',
  'home.weekdaySat': 'S',

  // Island search
  'home.searchPlaceholder': 'Search islands',
  'home.closeSearchAccessibilityLabel': 'Close search',

  // Podcast tab
  'home.podcastSearchPlaceholder': 'Search podcast or URL',
  'home.podcastCatalogError': 'The catalog could not be loaded.',
  'home.podcastSearchError': 'That could not be searched.',
  'home.podcastNoShowsFound': 'No shows found.',
  'home.podcastLevelBeginner': 'Beginner',
  'home.podcastLevelIntermediate': 'Intermediate',
  'home.podcastLevelAdvanced': 'Advanced',
  'home.podcastViewAll': 'View all {count}',

  // Podcast episodes
  'home.episodesTitle': 'Episodes',
  'home.episodeConfirmTitle': 'Make an island from this episode?',
  'home.episodeConfirmBody': 'It downloads the audio and builds the lines, which takes a few minutes.',
  'home.episodeConfirmAction': 'Make island',
  'home.episodesFeedError': 'The feed could not be loaded.',
  'home.episodeFallbackTitle': 'Podcast episode',
  'home.untitledEpisode': 'Untitled episode',

  // Add-island sheet and ready-made phrases
  'home.addTitle': 'Add an island',
  'home.add.record': 'Record',
  'home.add.phrases': 'Phrases',
  'home.noIslandsHint': 'Tap + to record, pick ready-made phrases, import audio, or paste a YouTube link.',
  'home.phrasesTitle': 'Phrases',
  'home.phrasesError': 'The phrases could not be loaded.',
  'home.phrasesCount': '{count} phrases',
  'home.phrasesCount_one': '{count} phrase',
  'home.phrasesCount_two': '{count} phrases',
  'home.phrasesCount_other': '{count} phrases',
  'phrases.prompt': 'What do you want to say?',
  'phrases.promptHint': 'Tap the red dot and say a topic, like "the gym"',
  'phrases.micLabel': 'Say a topic',
  'phrases.topicHint': 'Making phrases about what you said. Under a minute.',
  'phrases.added': 'Added',
  'phrases.tabPhrases': 'Phrases',
  'phrases.tabGrammar': 'Grammar',
  'phrases.flipHint': '‹ drag sideways to flip ›',
  'phrases.grammarSearch': 'Search grammar by pattern, reading or meaning',
  'phrases.grammarSearchClear': 'Clear search',
  'phrases.grammarNoMatch': 'No grammar point matches that',
  'home.phrasesBuildHint': 'This takes under a minute. You can close this screen, the island keeps building and appears in your list when it is ready.',

  // Streak reminder: the one-time offer on Home and the notification itself.
  'streak.offerTitle': 'Keep the streak going?',
  'streak.offerBody': 'Echo Tail can remind you at {hour}:00 on a day you have not practised yet. You can change the hour in Settings.',
  'streak.offerYes': 'Remind me',
  'streak.offerNo': 'Not now',
  'streak.notifyTitle': 'Your streak is at risk',
  'streak.notifyBody': '{count} days in a row. One sentence ladder today keeps it going.',
  'streak.notifyBody_one': '{count} day in a row. One sentence ladder today keeps it going.',
  'streak.notifyBody_two': '{count} days in a row. One sentence ladder today keeps it going.',
  'streak.notifyBody_other': '{count} days in a row. One sentence ladder today keeps it going.',
  // Streak freeze purchase (the confirm sheet behind the Streak sheet's buy row).
  'streak.buyTitle': 'Buy a streak freeze?',
  'streak.buyBody': 'A day off keeps your streak. {price} coins, you have {coins}.',
  'streak.buyFor': 'Buy for {n}',
  'streak.buyFailed': 'Could not buy the freeze',
  'home.streakStart': 'Start your streak',
  'home.streakDays': '{n} day streak',
  'home.streakDays_one': '1 day streak',
  'home.streakDays_two': '{n} day streak',
  'home.streakKeep': 'Practice today to keep it',
  'streak.title': 'Streak',
  'streak.dayStreak': 'day streak',
  'streak.dayStreak_one': 'day streak',
  'streak.dayStreak_two': 'day streak',
  'streak.longest': 'Longest: {n}',
  'streak.held': '{held} of {cap} freezes',
  'streak.lastUsed': 'Used on {date}',
  'streak.buy': 'Buy a freeze · {n} coins',
  'streak.buyLabel': 'Buy a freeze',
  'streak.needCoins': 'Need {n} more coins',
  'streak.atCap': 'You hold the most you can',
  'streak.how': 'A freeze is used on its own when you miss a day. It does not add a day.',
  'streak.keepGoing': 'Keep going',
  'streak.milestone': '{n} day milestone',
  'streak.endedTitle': 'Your {n} day streak ended',
  'streak.freezeTip': 'A streak freeze keeps your streak on a day off.',
  'streak.startNew': 'Start a new streak',
  'streak.buyFreeze': 'Buy a freeze · {n} 🪙',
  'streak.freezeReady': '1 freeze held for your new streak',
  'streak.notNow': 'Not now',
};
