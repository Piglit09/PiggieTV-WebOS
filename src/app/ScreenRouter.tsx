import React from 'react';
import { useApp } from '../state/appContext';
import { StartupScreen } from '../screens/StartupScreen';
import { ServerScreen } from '../screens/login/ServerScreen';
import { AuthScreen } from '../screens/login/AuthScreen';
import { QuickConnectScreen } from '../screens/login/QuickConnectScreen';
import { HomeScreen } from '../screens/home/HomeScreen';
import { MoviesScreen } from '../screens/browse/MoviesScreen';
import { ShowsScreen } from '../screens/browse/ShowsScreen';
import { MusicScreen } from '../screens/browse/MusicScreen';
import { ReadingScreen } from '../screens/browse/ReadingScreen';
import { SearchScreen } from '../screens/search/SearchScreen';
import { DetailsScreen } from '../screens/details/DetailsScreen';
import { SettingsScreen } from '../screens/settings/SettingsScreen';
import { DiagnosticsScreen } from '../screens/diagnostics/DiagnosticsScreen';

export function ScreenRouter() {
  const { state } = useApp();

  switch (state.route.screen) {
    case 'startup':
      return <StartupScreen />;
    case 'server':
      return <ServerScreen />;
    case 'auth':
      return <AuthScreen />;
    case 'quick-connect':
      return <QuickConnectScreen />;
    case 'movies':
      return <MoviesScreen />;
    case 'shows':
      return <ShowsScreen />;
    case 'music':
      return <MusicScreen />;
    case 'reading':
      return <ReadingScreen />;
    case 'search':
      return <SearchScreen />;
    case 'details':
      return <DetailsScreen />;
    case 'settings':
      return <SettingsScreen />;
    case 'diagnostics':
      return <DiagnosticsScreen />;
    case 'playback':
      return null;
    case 'home':
    default:
      return <HomeScreen />;
  }
}
