import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { border, color, maxContentWidth, shadow, space, type } from '@/lib/theme';

export function Screen({
  title,
  badge,
  children,
  scroll = true,
  footer,
}: {
  title: string;
  badge?: string;
  children: ReactNode;
  scroll?: boolean;
  footer?: ReactNode;
}) {
  const body = scroll ? (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={styles.scrollContent}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.flex, styles.staticContent]}>{children}</View>
  );

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'left', 'right']}>
      <View style={styles.frame}>
        <View style={styles.header}>
          <Text style={type.heading}>{title}</Text>
          {badge ? <NeoBadge label={badge} /> : null}
        </View>
        {body}
        {footer}
      </View>
    </SafeAreaView>
  );
}

export function NeoCard({
  children,
  style,
  accent = false,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  accent?: boolean;
}) {
  return (
    <View style={[styles.card, accent && styles.cardAccent, style]}>{children}</View>
  );
}

export function NeoButton({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'accent' | 'ghost';
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const isAccent = variant === 'accent';
  const isGhost = variant === 'ghost';
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.button,
        isAccent && styles.buttonAccent,
        isGhost && styles.buttonGhost,
        pressed && styles.buttonPressed,
        (disabled || loading) && styles.buttonDisabled,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={isAccent ? color.paper : color.ink} />
      ) : (
        <Text
          style={[
            styles.buttonLabel,
            isAccent && styles.buttonLabelAccent,
          ]}
          numberOfLines={1}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

export function NeoBadge({ label, accent = false }: { label: string; accent?: boolean }) {
  return (
    <View style={[styles.badge, accent && styles.badgeAccent]}>
      <Text style={[styles.badgeLabel, accent && styles.badgeLabelAccent]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

export function NeoInput(props: TextInputProps & { style?: StyleProp<TextStyle> }) {
  return (
    <TextInput
      placeholderTextColor="#8A8A8A"
      {...props}
      style={[styles.input, props.style]}
    />
  );
}

export function NeoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

export function SectionTitle({ label }: { label: string }) {
  return (
    <View style={styles.sectionTitle}>
      <View style={styles.sectionTick} />
      <Text style={type.subheading}>{label}</Text>
    </View>
  );
}

export function InlineNotice({ text, accent = false }: { text: string; accent?: boolean }) {
  return (
    <View style={[styles.notice, accent && styles.noticeAccent]}>
      <Text style={[type.small, accent && { color: color.paper }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: {
    flex: 1,
    backgroundColor: color.paper,
  },
  frame: {
    flex: 1,
    width: '100%',
    maxWidth: maxContentWidth,
    alignSelf: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
    borderBottomWidth: border.width,
    borderColor: color.ink,
    gap: space.xs,
  },
  scrollContent: {
    padding: space.sm,
    gap: space.sm,
    paddingBottom: space.xl,
  },
  staticContent: {
    padding: space.sm,
    gap: space.sm,
  },
  card: {
    borderWidth: border.width,
    borderColor: color.ink,
    backgroundColor: color.paper,
    padding: space.sm,
    gap: space.xs,
    ...shadow.hard,
  },
  cardAccent: {
    borderColor: color.accent,
    shadowColor: color.accent,
  },
  button: {
    borderWidth: border.width,
    borderColor: color.ink,
    backgroundColor: color.paper,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs + 4,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    ...shadow.hardSmall,
  },
  buttonAccent: {
    backgroundColor: color.accent,
  },
  buttonGhost: {
    shadowOpacity: 0,
    elevation: 0,
  },
  buttonPressed: {
    backgroundColor: color.paperPressed,
    shadowOffset: { width: 0, height: 0 },
    transform: [{ translateX: 2 }, { translateY: 2 }],
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  buttonLabel: {
    ...type.subheading,
  },
  buttonLabelAccent: {
    color: color.paper,
  },
  badge: {
    borderWidth: border.width,
    borderColor: color.ink,
    paddingHorizontal: space.xs,
    paddingVertical: 4,
    backgroundColor: color.paper,
    maxWidth: 200,
  },
  badgeAccent: {
    backgroundColor: color.accent,
    borderColor: color.ink,
  },
  badgeLabel: {
    ...type.small,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  badgeLabelAccent: {
    color: color.paper,
  },
  input: {
    borderWidth: border.width,
    borderColor: color.ink,
    backgroundColor: color.paper,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs + 4,
    minHeight: 48,
    ...type.body,
    lineHeight: 20,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: space.sm,
  },
  rowLabel: {
    ...type.small,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingTop: 2,
  },
  rowValue: {
    ...type.body,
    lineHeight: 20,
    flex: 1,
    textAlign: 'right',
  },
  sectionTitle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    marginTop: space.xs,
  },
  sectionTick: {
    width: 12,
    height: 12,
    backgroundColor: color.accent,
    borderWidth: border.width,
    borderColor: color.ink,
  },
  notice: {
    borderWidth: border.width,
    borderColor: color.ink,
    backgroundColor: color.paperPressed,
    padding: space.xs,
  },
  noticeAccent: {
    backgroundColor: color.accent,
  },
});
