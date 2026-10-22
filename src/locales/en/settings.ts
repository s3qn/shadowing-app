/**
 * Settings tab and its screens. Filled in gradually: only the app language
 * screen's own copy lives here for now (Task 1); the rest of the settings
 * screens fill in when their own strings move to `t()`.
 */
export const en = {
  'settings.appLanguage': 'App language',
  'settings.appLanguageAuto': 'Same as understood',

  // Settings tab: the section headers and the rows under them. Separate keys
  // from `title.*` in common.ts, which names the screen a row opens.
  'settings.section.practice': 'Practice',
  'settings.section.playback': 'Playback',
  'settings.section.voice': 'Voice',
  'settings.section.language': 'Language',
  'settings.section.appearance': 'Appearance',
  'settings.section.data': 'Data',
  'settings.section.about': 'About',
  'settings.section.feedback': 'Feedback',
  'settings.row.practice': 'Reading, pitch, defaults',
  'settings.row.practiceOther': 'Translation and blind defaults',
  'settings.row.playback': 'Speed, pace, repeat, pause, Auto Echo',
  'settings.row.voice': 'Voice',
  'settings.row.languages': 'Learning, understood',
  'settings.row.showAllLanguages': 'Show all languages',
  'settings.row.haptics': 'Haptics',
  'settings.row.alwaysNightSky': 'Always night sky',
  'settings.row.data': 'Storage, delete takes',
  'settings.row.about': 'Version, credits',
  'settings.row.replayOnboarding': 'Replay onboarding',
  'settings.row.feedback': 'Report a bug or idea',

  // Language names, shown wherever `LanguageEntry.english` would otherwise
  // render untranslated (the picker's subtitle). The
  // native name (עברית, 日本語, ...) never changes.
  'language.ja': 'Japanese',
  'language.es': 'Spanish',
  'language.en': 'English',
  'language.he': 'Hebrew',
  'language.fr': 'French',
  'language.de': 'German',
  'language.pt': 'Portuguese',
  'language.it': 'Italian',
  'language.ru': 'Russian',
  'language.ko': 'Korean',
  'language.zh': 'Chinese',
  'language.hi': 'Hindi',
  'language.ar': 'Arabic',

  // Language picker (onboarding and Settings > Language).
  'settings.picker.searchPlaceholder': 'Search a language',
  'settings.picker.regionAll': 'All',
  'settings.picker.regionEurope': 'Europe',
  'settings.picker.regionAsia': 'Asia',
  'settings.picker.regionMiddleEast': 'Middle East',
  'settings.picker.regionAfrica': 'Africa',
  'settings.picker.regionAmericas': 'Americas',
  'settings.picker.readyToLearn': 'Ready to learn',
  'settings.picker.comingSoon': 'Coming soon',
  'settings.picker.allLanguages': 'All languages',
  'settings.picker.soon': 'Soon',
  'settings.picker.noMatch': 'No languages match "{query}".',

  // Settings > Language (learn / understand pickers).
  'settings.languages.learn': 'I want to learn',
  'settings.languages.understand': 'I understand',

  // Asked only at the moment the interface language and the understood
  // language would stop matching (see `src/lib/language-sync.ts`).
  'settings.langPair.translationsTitle': 'Change translations too?',
  'settings.langPair.translationsBody':
    'The app is in {lang} now. Translations and explanations still come in {other}. Change those to {lang} too? Existing islands keep their translations.',
  'settings.langPair.appTitle': 'Change the app language too?',
  'settings.langPair.appBody':
    'New islands will be translated into {lang}. The app itself is still in {other}. Change it to {lang} too? Existing islands keep their translations.',

  // Settings > About.
  'settings.about.app': 'App',
  'settings.about.appFootnote': 'Islands belong to this phone. Sean needs this id once to keep his own islands.',
  'settings.about.version': 'Version',
  'settings.about.unknown': 'Unknown',
  'settings.about.deviceId': 'Device ID',
  'settings.about.credits': 'Credits',
  'settings.about.creditsFootnote':
    'Speech is generated with VOICEVOX and transcribed with faster-whisper, both open source and run on this device’s own network.',
  'settings.about.voiceSynthesis': 'Voice synthesis',
  'settings.about.exampleSentences': 'Example sentences, adapted',
  'settings.about.speechRecognition': 'Speech recognition',
  'settings.about.artwork': 'Artwork',
  // The names and the licence code stay as they are in every language.
  'settings.about.artworkFootnote': 'Animated emoji by Google (Noto Emoji), licensed under CC BY 4.0.',
  'settings.about.animatedEmoji': 'Animated emoji',
  'settings.about.licences': 'Licences',
  'settings.about.licencesFootnote': 'Every open source dependency keeps its own licence, unmodified.',
  'settings.about.openSourceLicences': 'Open source licences',
  // The filename is the value, so it is never translated.
  'settings.about.seePackageJson': 'See package.json',

  // Settings > Data.
  'settings.data.storage': 'Storage',
  'settings.data.storageFootnote': 'Every recording made while shadowing, across every island.',
  'settings.data.takesOnDevice': 'Takes on this device',
  'settings.data.takes': 'Takes',
  'settings.data.downloadedIslands': 'Downloaded islands',
  'settings.data.downloadedValue': '{count} · {size}',
  'settings.data.deleteAllDownloads': 'Delete all downloads',
  'settings.data.deleteDownloadsTitle': 'Delete all downloads?',
  'settings.data.deleteDownloadsBody': 'Every island downloaded for offline use is removed from this phone. Nothing on the server changes.',
  'settings.data.deleteAllTakes': 'Delete all takes',
  'settings.data.deleteAllTitle': 'Delete all takes?',
  'settings.data.deleteAllBody': 'This removes every recording on this device. Islands themselves are not affected.',
  'settings.data.deleteAllConfirm': 'Delete all',
  'settings.data.backend': 'Backend',
  'settings.data.server': 'Server',
  'settings.data.notSet': 'Not set',
  'settings.data.connection': 'Connection',
  'settings.data.checking': 'Checking…',
  'settings.data.connected': 'Connected',
  'settings.data.offline': 'Offline',

  // Settings > Playback.
  'settings.playback.speed': 'Speed',
  'settings.playback.defaultFootnote':
    'Where a new island starts. Each island climbs toward 1.20× by itself when you keep up with 90% of the words over three takes, and steps back under 85%, never below this speed. The Speed tile in the player still sets it by hand.',
  'settings.playback.times': 'Times',
  'settings.playback.timesFootnote':
    'How many times each line plays before the next. Default for new sessions; change it per session from the player’s Repeat tile.',
  'settings.playback.timesAccessibility': 'Times, {label}',
  'settings.playback.pace': 'Pace',
  'settings.playback.paceCalm': 'Calm',
  'settings.playback.paceSteady': 'Steady',
  'settings.playback.paceQuick': 'Quick',
  'settings.playback.paceFootnote':
    'How long each stage announces itself and counts in, and how often Mumble and Read along repeat. Calm: two repeats, longer counts. Quick: one repeat, short counts.',
  'settings.playback.blindTake': 'Last take without the text',
  'settings.playback.blindTakeFootnote':
    'After the recorded take, one more take from memory with the sentence hidden. Off ends on the recorded take.',
  'settings.playback.pause': 'Pause',
  'settings.playback.pauseFootnote':
    'Silence after every play. Default for new sessions; change it per session from the player’s Repeat tile.',
  'settings.playback.pauseAccessibility': 'Pause, {label}',
  'settings.playback.autoEcho': 'Auto Echo',
  'settings.playback.autoRecord': 'Auto record',
  'settings.playback.autoRecordFootnote':
    'Auto record opens the mic after Say on its own. Auto Echo only decides whether the next line starts on its own.',
  'settings.playback.screen': 'Screen',
  'settings.playback.keepScreenAwake': 'Keep screen awake',

  // Settings > Practice.
  'settings.practice.reading': 'Reading',
  'settings.practice.readingOff': 'Off',
  'settings.practice.readingFurigana': 'Furigana',
  'settings.practice.readingKana': 'Kana',
  'settings.practice.readingRomaji': 'Romaji',
  'settings.practice.readingFootnote': 'How Japanese is written under each line. Applies to every island.',
  'settings.practice.defaults': 'Practice defaults',
  'settings.practice.defaultsFootnote': 'How each new session starts. You can still change these in the player.',
  'settings.practice.pitchMarks': 'Pitch marks',
  'settings.practice.hideEnglish': 'Hide the translation by default',
  'settings.practice.blindByDefault': 'Blind by default',

  // Settings > Suggest a feature.

  // Settings > Voice.
  'settings.voice.comingSoonNote': '{name} is not ready yet. Islands are built in {lang} for now.',
  'settings.voice.availableFor':
    'Voices for {lang}. Tap one to hear it; the one you pick is used for new {lang} islands.',
  'settings.voice.female': 'female',
  'settings.voice.male': 'male',
  'settings.voice.loadError': 'Could not load voices',
  'settings.voice.credit': 'Audio made with this voice is credited as VOICEVOX:{name}',

  // Onboarding.
  'settings.onboarding.skip': 'Skip',
  'settings.onboarding.continue': 'Continue',
  'settings.onboarding.gotIt': 'Got it',
  'settings.onboarding.getStarted': 'Get started',
  'settings.onboarding.tagline': 'Learn a language by following its voice, one sentence at a time.',
  'settings.onboarding.languagesStep1': 'Languages · 1 of 2',
  'settings.onboarding.languagesStep2': 'Languages · 2 of 2',
  'settings.onboarding.micKicker': 'Microphone',
  'settings.onboarding.micTitle': 'Echo Tail listens to you',
  'settings.onboarding.micLine':
    'Your voice is compared with the native voice so you can hear the difference. Nothing is shared.',
  'settings.onboarding.allowMicrophone': 'Allow microphone',
  'settings.onboarding.micError': 'Microphone access is off. Turn it on in Settings and try again.',
  'settings.onboarding.notNow': 'Not now',
  'settings.onboarding.goalKicker': 'Daily goal',
  'settings.onboarding.goalTitle': 'How long a day?',
  'settings.onboarding.goalLine':
    'Short and daily beats long and rare. A day counts once you finish one full sentence ladder.',
  'settings.onboarding.goalMinutes': '{n} minutes',
  'settings.onboarding.goalHint5': 'A few sentences',
  'settings.onboarding.goalHint10': 'One island',
  'settings.onboarding.goalHint20': 'Deep practice',
  // The pass kicker names the pass and the speed it plays at: "Pass 1 ·
  // Listen · 0.7×". Compare gives the speed the next round runs at instead.
  'settings.onboarding.passKicker': 'Pass {n} · {name} · {speed}×',
  'settings.onboarding.passKickerNext': 'Pass {n} · {name} · next time {speed}×',
  // The ladder overview: one row per pass, with the speed on the trailing side.
  'settings.onboarding.ladderListen': 'Text in view',
  'settings.onboarding.ladderMemorise': 'Read along, twice',
  'settings.onboarding.ladderSay': 'Say it with the voice',
  'settings.onboarding.ladderRecord': 'One recorded take',
  'settings.onboarding.ladderCompare': 'You next to the voice',
  'settings.onboarding.passListenHeadline': 'Listen with the text in view',
  'settings.onboarding.passMemoriseHeadline': 'Read it to yourself',
  'settings.onboarding.passSayHeadline': 'Say it with the voice',
  'settings.onboarding.passRecordHeadline': 'One take, from memory',
  'settings.onboarding.passCompareHeadline': 'Hear yourself next to the voice',
  'settings.onboarding.passListenTitle': 'Listen',
  'settings.onboarding.passListenLine': 'Hear the sentence once, eyes on the text.',
  'settings.onboarding.passMemoriseTitle': 'Mumble',
  'settings.onboarding.passMemoriseLine': 'The voice plays it again. Follow the text and keep it.',
  'settings.onboarding.passSayTitle': 'Read along',
  'settings.onboarding.passSayLine': 'Say it out loud in step with the voice, text in view.',
  'settings.onboarding.passRecordTitle': 'Shadow',
  'settings.onboarding.passRecordLine': 'Speak with the voice, a beat behind it.',
  'settings.onboarding.passCompareTitle': 'Compare',
  'settings.onboarding.passCompareLine': 'Hear the voice and your take together. Next time, a little faster.',
  'settings.onboarding.voiceLane': 'voice',
  'settings.onboarding.youLane': 'you',
  'settings.onboarding.keptUp': '10 of 12 kept up',

  // Account: sign-in step, Settings section.
  'settings.section.account': 'Account',
  'settings.account.kicker': 'Account',
  'settings.account.noToken': '{provider} did not send a sign-in token.',
  'settings.account.title': 'Keep your islands safe',
  'settings.account.body': 'Your recordings and progress follow you to a new phone.',
  'settings.account.apple': 'Continue with Apple',
  'settings.account.google': 'Continue with Google',
  'settings.account.privacyLine': 'Your voice recordings stay private to your account.',
  'settings.account.signingIn': 'Signing in',
  'settings.account.failed': 'Sign-in did not finish. Try again.',
  'settings.account.expoGo': 'Expo Go: continue without an account',
  'settings.account.signedInWith': 'Signed in with {provider}',
  'settings.account.deleteTitle': 'Delete your account?',
  'settings.account.deleteBody':
    'This deletes your account, every island you built and all recordings on the server. It cannot be undone.',
  'settings.account.deleteConfirm': 'Delete',
  'settings.row.signOut': 'Sign out',
  'settings.row.deleteAccount': 'Delete account',
  'username.title': 'Choose your username',
  'username.error': 'Could not check right now. Try again.',
  'username.hint': '3-20 letters, numbers or underscores.',
  'username.available': 'Available',
  'username.taken': 'That username is taken.',
  'username.invalid': 'Use 3-20 letters, numbers or underscores.',
  'username.save': 'Save',
  'username.checking': 'Checking…',
  'username.settingsRow': 'Username',
  'username.notSet': 'Not set',
  'feedback.hint': 'Found a bug or have an idea? Write it, say it, or add a screenshot.',
  'feedback.kind.bug': 'Bug',
  'feedback.kind.suggestion': 'Suggestion',
  'feedback.placeholder.bug': 'What happened, and where?',
  'feedback.placeholder.suggestion': 'What should the app do?',
  'feedback.record': 'Record voice',
  'feedback.stop': 'Stop {time}',
  'feedback.voiceNote': 'Voice note {time}',
  'feedback.addImage': 'Add screenshot',
  'feedback.micDenied': 'Microphone access is off. Write instead.',
  'feedback.privacy': 'Sent with it: your username, app version and device model.',
  'feedback.send': 'Send',
  'feedback.sending': 'Sending',
  'feedback.sent': 'Got it. Thanks, that helps.',
  'feedback.queued': "No connection. Saved; it sends when you're back online.",
  'feedback.error': 'Could not send that. Try again.',

  // Streak reminder: Settings section, permission and build notes, the dev test row.
  'settings.section.streak': 'Streak',
  'settings.streak.reminder': 'Evening reminder',
  'settings.streak.reminderFootnote':
    'A notification at the hour you pick, only on a day you have not practised yet while a streak is running. One finished sentence ladder or 10 passes count as practice.',
  'settings.streak.permissionOff': "Notifications are off for Echo Tail. Turn them on in the phone's Settings and try again.",
  'settings.streak.needsBuild': 'Reminders need the installed app, not Expo Go or the web preview.',
  'settings.streak.testRow': 'Test reminder in 10 seconds',
  'settings.streak.channel': 'Streak reminders',
};
