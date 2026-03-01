import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';
import enChannels from './locales/en/channels.json';
// Import translations
import enCommon from './locales/en/common.json';
import enDownload from './locales/en/download.json';
import enMetadata from './locales/en/metadata.json';
import enPages from './locales/en/pages.json';
import enSettings from './locales/en/settings.json';
import enSubtitles from './locales/en/subtitles.json';
import enUniversal from './locales/en/universal.json';
import frChannels from './locales/fr/channels.json';
import frCommon from './locales/fr/common.json';
import frDownload from './locales/fr/download.json';
import frMetadata from './locales/fr/metadata.json';
import frPages from './locales/fr/pages.json';
import frSettings from './locales/fr/settings.json';
import frSubtitles from './locales/fr/subtitles.json';
import frUniversal from './locales/fr/universal.json';
import ptChannels from './locales/pt/channels.json';
import ptCommon from './locales/pt/common.json';
import ptDownload from './locales/pt/download.json';
import ptMetadata from './locales/pt/metadata.json';
import ptPages from './locales/pt/pages.json';
import ptSettings from './locales/pt/settings.json';
import ptSubtitles from './locales/pt/subtitles.json';
import ptUniversal from './locales/pt/universal.json';

import ruChannels from './locales/ru/channels.json';
import ruCommon from './locales/ru/common.json';
import ruDownload from './locales/ru/download.json';
import ruMetadata from './locales/ru/metadata.json';
import ruPages from './locales/ru/pages.json';
import ruSettings from './locales/ru/settings.json';
import ruSubtitles from './locales/ru/subtitles.json';
import ruUniversal from './locales/ru/universal.json';
import viChannels from './locales/vi/channels.json';
import viCommon from './locales/vi/common.json';
import viDownload from './locales/vi/download.json';
import viMetadata from './locales/vi/metadata.json';
import viPages from './locales/vi/pages.json';
import viSettings from './locales/vi/settings.json';
import viSubtitles from './locales/vi/subtitles.json';
import viUniversal from './locales/vi/universal.json';
import zhCNChannels from './locales/zh-CN/channels.json';
import zhCNCommon from './locales/zh-CN/common.json';
import zhCNDownload from './locales/zh-CN/download.json';
import zhCNMetadata from './locales/zh-CN/metadata.json';
import zhCNPages from './locales/zh-CN/pages.json';
import zhCNSettings from './locales/zh-CN/settings.json';
import zhCNSubtitles from './locales/zh-CN/subtitles.json';
import zhCNUniversal from './locales/zh-CN/universal.json';

const resources = {
  en: {
    common: enCommon,
    channels: enChannels,
    download: enDownload,
    metadata: enMetadata,
    universal: enUniversal,
    pages: enPages,
    settings: enSettings,
    subtitles: enSubtitles,
  },
  fr: {
    common: frCommon,
    channels: frChannels,
    download: frDownload,
    metadata: frMetadata,
    universal: frUniversal,
    pages: frPages,
    settings: frSettings,
    subtitles: frSubtitles,
  },
  vi: {
    common: viCommon,
    channels: viChannels,
    download: viDownload,
    metadata: viMetadata,
    universal: viUniversal,
    pages: viPages,
    settings: viSettings,
    subtitles: viSubtitles,
  },
  'zh-CN': {
    common: zhCNCommon,
    channels: zhCNChannels,
    download: zhCNDownload,
    metadata: zhCNMetadata,
    universal: zhCNUniversal,
    pages: zhCNPages,
    settings: zhCNSettings,
    subtitles: zhCNSubtitles,
  },
  pt: {
    common: ptCommon,
    channels: ptChannels,
    download: ptDownload,
    metadata: ptMetadata,
    universal: ptUniversal,
    pages: ptPages,
    settings: ptSettings,
    subtitles: ptSubtitles,
  },
  ru: {
    common: ruCommon,
    channels: ruChannels,
    download: ruDownload,
    metadata: ruMetadata,
    universal: ruUniversal,
    pages: ruPages,
    settings: ruSettings,
    subtitles: ruSubtitles,
  },
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'en',
    defaultNS: 'common',
    ns: [
      'common',
      'channels',
      'download',
      'metadata',
      'universal',
      'pages',
      'settings',
      'subtitles',
    ],

    detection: {
      order: ['localStorage', 'navigator', 'htmlTag'],
      caches: ['localStorage'],
    },

    interpolation: {
      escapeValue: false,
    },
  });

export default i18n;
