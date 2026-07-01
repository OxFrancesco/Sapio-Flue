import { TabList, TabSlot, TabTrigger, Tabs } from 'expo-router/ui';
import { forwardRef, type ComponentProps } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { border, color, maxContentWidth } from '@/lib/theme';

type TabButtonProps = ComponentProps<typeof Pressable> & {
  label: string;
  isFocused?: boolean;
};

const TabButton = forwardRef<View, TabButtonProps>(function TabButton(
  { label, isFocused, ...props },
  ref,
) {
  return (
    <Pressable
      ref={ref}
      {...props}
      accessibilityRole="tab"
      style={[styles.tabButton, isFocused && styles.tabButtonFocused]}
    >
      <Text style={[styles.tabLabel, isFocused && styles.tabLabelFocused]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
});

export default function TabsLayout() {
  return (
    <Tabs style={styles.tabs}>
      <TabSlot />
      <SafeAreaView edges={['bottom']} style={styles.tabBarSafeArea}>
        <View style={styles.tabBarFrame}>
          <TabList asChild>
            <View style={styles.tabList}>
              <TabTrigger name="chat" href="/" asChild>
                <TabButton label="Chat" />
              </TabTrigger>
              <TabTrigger name="model" href="/model" asChild>
                <TabButton label="Model" />
              </TabTrigger>
              <TabTrigger name="workspace" href="/workspace" asChild>
                <TabButton label="Space" />
              </TabTrigger>
              <TabTrigger name="pages" href="/pages" asChild>
                <TabButton label="Pages" />
              </TabTrigger>
              <TabTrigger name="settings" href="/settings" asChild>
                <TabButton label="Setup" />
              </TabTrigger>
            </View>
          </TabList>
        </View>
      </SafeAreaView>
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabs: {
    flex: 1,
    backgroundColor: color.paper,
  },
  tabBarSafeArea: {
    backgroundColor: color.ink,
  },
  tabBarFrame: {
    width: '100%',
    maxWidth: maxContentWidth,
    alignSelf: 'center',
  },
  tabList: {
    flexDirection: 'row',
    borderTopWidth: border.width,
    borderColor: color.ink,
    backgroundColor: color.ink,
    gap: border.width,
    paddingTop: border.width,
  },
  tabButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    backgroundColor: color.paper,
  },
  tabButtonFocused: {
    backgroundColor: color.accent,
  },
  tabLabel: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: color.ink,
  },
  tabLabelFocused: {
    color: color.paper,
  },
});
