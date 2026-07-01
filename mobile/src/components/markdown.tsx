import * as WebBrowser from 'expo-web-browser';
import { StyleSheet, Text, View } from 'react-native';
import { border, color, space, type } from '@/lib/theme';

type Block =
  | { kind: 'heading'; text: string }
  | { kind: 'bullet'; text: string; checked?: boolean }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'paragraph'; text: string };

function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  let index = 0;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
      paragraph = [];
    }
  };

  while (index < lines.length) {
    const line = lines[index];
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      flushParagraph();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^ {0,3}(`{3,}|~{3,})/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      blocks.push({ kind: 'code', text: code.join('\n') });
      index += 1;
      continue;
    }

    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({ kind: 'heading', text: heading[1] });
      index += 1;
      continue;
    }

    const task = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (task) {
      flushParagraph();
      blocks.push({ kind: 'bullet', text: task[2], checked: task[1] !== ' ' });
      index += 1;
      continue;
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      blocks.push({ kind: 'bullet', text: bullet[1] });
      index += 1;
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph();
      blocks.push({ kind: 'quote', text: quote[1] });
      index += 1;
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      index += 1;
      continue;
    }

    paragraph.push(line.trim());
    index += 1;
  }
  flushParagraph();
  return blocks;
}

type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string };

const INLINE_PATTERN = /(\*\*[^*]+\*\*|`[^`]+`|https?:\/\/\S+)/g;

function parseInline(text: string): Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const start = match.index ?? 0;
    if (start > last) {
      segments.push({ kind: 'text', text: text.slice(last, start) });
    }
    const token = match[0];
    if (token.startsWith('**')) {
      segments.push({ kind: 'bold', text: token.slice(2, -2) });
    } else if (token.startsWith('`')) {
      segments.push({ kind: 'code', text: token.slice(1, -1) });
    } else {
      segments.push({ kind: 'link', text: token });
    }
    last = start + token.length;
  }
  if (last < text.length) {
    segments.push({ kind: 'text', text: text.slice(last) });
  }
  return segments;
}

function InlineText({ text, baseStyle }: { text: string; baseStyle: object }) {
  return (
    <Text style={baseStyle}>
      {parseInline(text).map((segment, index) => {
        if (segment.kind === 'bold') {
          return (
            <Text key={index} style={styles.bold}>
              {segment.text}
            </Text>
          );
        }
        if (segment.kind === 'code') {
          return (
            <Text key={index} style={styles.inlineCode}>
              {segment.text}
            </Text>
          );
        }
        if (segment.kind === 'link') {
          return (
            <Text
              key={index}
              style={styles.link}
              onPress={() => void WebBrowser.openBrowserAsync(segment.text)}
            >
              {segment.text}
            </Text>
          );
        }
        return <Text key={index}>{segment.text}</Text>;
      })}
    </Text>
  );
}

export function Markdown({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  return (
    <View style={styles.container}>
      {blocks.map((block, index) => {
        if (block.kind === 'heading') {
          return <InlineText key={index} text={block.text} baseStyle={styles.heading} />;
        }
        if (block.kind === 'code') {
          return (
            <View key={index} style={styles.codeBlock}>
              <Text style={type.mono}>{block.text}</Text>
            </View>
          );
        }
        if (block.kind === 'bullet') {
          return (
            <View key={index} style={styles.bulletRow}>
              <Text style={styles.bulletMark}>
                {block.checked === undefined ? '■' : block.checked ? '☑' : '☐'}
              </Text>
              <View style={styles.bulletBody}>
                <InlineText text={block.text} baseStyle={type.body} />
              </View>
            </View>
          );
        }
        if (block.kind === 'quote') {
          return (
            <View key={index} style={styles.quote}>
              <InlineText text={block.text} baseStyle={type.body} />
            </View>
          );
        }
        return <InlineText key={index} text={block.text} baseStyle={type.body} />;
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: space.xs,
  },
  heading: {
    ...type.subheading,
    marginTop: 4,
  },
  bold: {
    fontWeight: '800',
  },
  inlineCode: {
    ...type.mono,
    backgroundColor: '#EFEFEF',
  },
  link: {
    color: color.accent,
    fontWeight: '800',
    textDecorationLine: 'underline',
  },
  codeBlock: {
    borderWidth: border.width,
    borderColor: color.ink,
    backgroundColor: '#F4F4F4',
    padding: space.xs,
  },
  bulletRow: {
    flexDirection: 'row',
    gap: space.xs,
    alignItems: 'flex-start',
  },
  bulletMark: {
    ...type.body,
    color: color.accent,
  },
  bulletBody: {
    flex: 1,
  },
  quote: {
    borderLeftWidth: 4,
    borderColor: color.accent,
    paddingLeft: space.xs,
  },
});
