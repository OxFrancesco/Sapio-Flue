import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { color } from '@/lib/theme';
import { AppProvider } from '@/lib/store';

export default function RootLayout() {
  return (
    <AppProvider>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: color.paper },
        }}
      />
    </AppProvider>
  );
}
