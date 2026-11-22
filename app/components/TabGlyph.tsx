import { StyleSheet, View, type ColorValue } from 'react-native';

/** Tab icons are drawn with hairlines so they stay crisp on every platform. */
export function TabGlyph({
  name,
  color,
}: {
  name: 'orders' | 'settings' | 'chat';
  color: ColorValue;
}) {
  if (name === 'chat') {
    return (
      <View style={styles.bubbles} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <View style={[styles.bubble, styles.bubbleBig, { borderColor: color }]} />
        <View style={[styles.bubble, styles.bubbleSmall, { borderColor: color }]} />
      </View>
    );
  }

  if (name === 'settings') {
    return (
      <View style={styles.sliders} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <View style={styles.sliderRow}>
          <View style={[styles.sliderLine, { backgroundColor: color }]} />
          <View style={[styles.knob, { backgroundColor: color, left: 2 }]} />
        </View>
        <View style={styles.sliderRow}>
          <View style={[styles.sliderLine, { backgroundColor: color }]} />
          <View style={[styles.knob, { backgroundColor: color, left: 10 }]} />
        </View>
        <View style={styles.sliderRow}>
          <View style={[styles.sliderLine, { backgroundColor: color }]} />
          <View style={[styles.knob, { backgroundColor: color, left: 6 }]} />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.list} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={styles.listRow}>
        <View style={[styles.dot, { backgroundColor: color }]} />
        <View style={[styles.line, { backgroundColor: color }]} />
      </View>
      <View style={styles.listRow}>
        <View style={[styles.dot, { backgroundColor: color }]} />
        <View style={[styles.line, { backgroundColor: color }]} />
      </View>
      <View style={styles.listRow}>
        <View style={[styles.dot, { backgroundColor: color }]} />
        <View style={[styles.line, { backgroundColor: color }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bubbles: {
    width: 20,
    height: 18,
    justifyContent: 'flex-start',
  },
  bubble: {
    borderWidth: 1.2,
    borderRadius: 7,
  },
  bubbleBig: {
    width: 14,
    height: 10,
  },
  bubbleSmall: {
    width: 9,
    height: 6,
    marginTop: 1.5,
    marginLeft: 7,
  },
  list: {
    width: 18,
    height: 16,
    justifyContent: 'space-between',
  },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  dot: {
    width: 3,
    height: 3,
    borderRadius: 1.5,
    marginRight: 5,
  },
  line: {
    width: 10,
    height: 1.5,
  },
  sliders: {
    width: 18,
    height: 16,
    justifyContent: 'space-between',
    paddingVertical: 1,
  },
  sliderRow: {
    height: 4,
    justifyContent: 'center',
  },
  sliderLine: {
    height: 1.5,
  },
  knob: {
    position: 'absolute',
    top: 0,
    width: 4,
    height: 4,
    borderRadius: 2,
  },
});
