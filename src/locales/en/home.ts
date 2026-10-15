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
  'home.autoPractice': 'Practice today',
  'home.autoPracticeNone': 'Nothing due today',
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
  'home.practiceStreak': 'Streak',
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
  'phrases.matched': 'Matches',
  'phrases.added': 'Added',
  'phrases.noMatch': 'No topics match. Try another chip.',
  'phrases.all': 'All',
  'phrases.preset.hello': 'Hello',
  'phrases.preset.restaurant': 'Restaurant',
  'phrases.preset.train': 'Train',
  'phrases.preset.intro': 'About me',
  'phrases.preset.shopping': 'Shopping',
  'phrases.preset.help': 'Help',
  'phrases.preset.chat': 'Small talk',
  'phrases.preset.weather': 'Weather',
  'home.phrasesBuildHint': 'This takes under a minute. You can close this screen, the island keeps building and appears in your list when it is ready.',
};
