import { Platform } from 'react-native';

export const color = {
  paper: '#FEFEFE',
  ink: '#030303',
  accent: '#D1001C',
  paperPressed: '#F1F1F1',
  accentPressed: '#A80016',
} as const;

export const space = {
  xs: 8,
  sm: 16,
  md: 24,
  lg: 32,
  xl: 40,
} as const;

export const border = {
  width: 2,
  radius: 0,
} as const;

export const shadow = {
  hard: {
    shadowColor: color.ink,
    shadowOffset: { width: 4, height: 4 },
    shadowOpacity: 1,
    shadowRadius: 0,
    elevation: 4,
  },
  hardSmall: {
    shadowColor: color.ink,
    shadowOffset: { width: 2, height: 2 },
    shadowOpacity: 1,
    shadowRadius: 0,
    elevation: 2,
  },
} as const;

export const type = {
  heading: {
    fontSize: 24,
    fontWeight: '800' as const,
    color: color.ink,
    textTransform: 'uppercase' as const,
    letterSpacing: 1,
  },
  subheading: {
    fontSize: 16,
    fontWeight: '800' as const,
    color: color.ink,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5,
  },
  body: {
    fontSize: 16,
    fontWeight: '400' as const,
    color: color.ink,
    lineHeight: 24,
  },
  small: {
    fontSize: 12,
    fontWeight: '400' as const,
    color: color.ink,
    lineHeight: 16,
  },
  mono: {
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    fontSize: 13,
    color: color.ink,
    lineHeight: 20,
  },
} as const;

export const maxContentWidth = 720;
