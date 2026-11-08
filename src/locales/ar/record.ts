import { isolate } from '@/lib/bidi';

export const ar = {
  'record.close': 'إغلاق',

  'record.title.idle': 'تحدّث عن يومك نحو 30 ثانية.',
  'record.title.recording': 'واصل الحديث عن يومك.',
  'record.title.review': 'تسجيلك',
  'record.topic.title.idle': 'قل موضوعًا',
  'record.topic.title.recording': 'جارٍ الاستماع…',
  'record.topic.title.review': 'موضوعك',
  'record.topic.hint': `قل موضوعًا، مثل «عبارات للنادي الرياضي»، أو قاعدة نحوية، مثل ${isolate('ながら')}`,
  'record.topic.hintNoGrammar': `قل موضوعًا، مثل «عبارات للنادي الرياضي»`,
  'record.topic.build': 'بناء العبارات',
  'record.promptHint':
    'تحدّث بإحدى اللغتين: {first} أو {second}، أيهما أسهل عليك. يتحول ما تقوله إلى جمل باللغة {language} عن حياتك أنت، فاستخدم أسماء وأماكن حقيقية.',
  'record.language.ja': 'اليابانية',
  'record.language.es': 'الإسبانية',
  'record.language.en': 'الإنجليزية',
  'record.language.he': 'العبرية',

  'record.mode.say': 'جملة واحدة',
  'record.mode.island': 'يومي',
  'record.say.title.idle': 'قل جملة واحدة باللغة {language}.',
  'record.say.title.recording': 'جارٍ الاستماع…',
  'record.say.hint': 'تعود إليك باللغة {language}، منطوقة وجاهزة للترديد.',
  'record.say.ready': 'تمت الترجمة وإضافة الصوت',
  'record.say.youSaid': 'ما قلته · {language}',
  'record.say.more': '+ {count} جملة أخرى',
  'record.say.more_one': '+ جملة أخرى',
  'record.say.more_two': '+ جملتان أخريان',
  'record.say.more_few': '+ {count} جمل أخرى',
  'record.say.more_many': '+ {count} جملة أخرى',
  'record.say.more_other': '+ {count} جملة أخرى',
  'record.say.back': 'جملة جديدة',
  'record.say.again': 'قلها مرة أخرى',
  'record.say.shadow': 'ردّدها',

  'record.waveform': 'الشكل الموجي لتسجيلك',
  'record.playRecording': 'تشغيل التسجيل',
  'record.pauseRecording': 'إيقاف التسجيل مؤقتًا',

  'record.sentencesLabel': 'الجمل',
  'record.complexity.simple.label': 'واحدة تلو الأخرى',
  'record.complexity.simple.description': 'جمل قصيرة مستقلة، في كل جملة فكرة واحدة.',
  'record.complexity.complex.label': 'معقدة',
  'record.complexity.complex.description': 'جمل فرعية وكلام متصل.',

  'record.styleLabel': 'الأسلوب',
  'record.register.polite.label': 'مهذب',
  'record.register.polite.description': `${isolate('です/ます')}، الأسلوب المعتاد في الحياة اليومية.`,
  'record.register.casual.label': 'غير رسمي',
  'record.register.casual.description': 'الصيغة البسيطة، كما تتحدث مع صديق.',

  'record.startRecording': 'بدء التسجيل',
  'record.stopRecording': 'إيقاف التسجيل',
  'record.tapToStart': 'اضغط للبدء',
  'record.tapToStop': 'اضغط للإيقاف',
  'record.keepGoing': 'واصل، بقي {seconds} ث',

  'record.buildIsland': 'بناء الجزيرة',
  'record.recordAgain': 'سجّل مرة أخرى',
  'record.discard': 'تجاهل',

  'record.buildHint': 'يستغرق هذا نحو دقيقة. يمكنك إغلاق هذه الشاشة، فالجزيرة تواصل البناء وتظهر في القائمة عندما تجهز.',
  'record.say.buildHint': 'يمكنك الرجوع، فالبناء مستمر.',
  'record.podcastBuildHint': 'يستغرق هذا بضع دقائق. يمكنك إغلاق هذه الشاشة، فالجزيرة تواصل البناء وتظهر في القائمة عندما تجهز.',
  'record.defaultEpisodeTitle': 'حلقة بودكاست',

  'record.micOff': 'الوصول إلى الميكروفون متوقف. فعّله من الإعدادات وأعد المحاولة.',
  'record.backgroundStopped': 'توقف التسجيل عندما انتقل التطبيق إلى الخلفية.',
  'record.uploadFailed': 'فشل الرفع',
  'record.episodeDownloadFailed': 'تعذّر تنزيل الحلقة.',
};
