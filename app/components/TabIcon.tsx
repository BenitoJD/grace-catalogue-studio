import Svg, { Circle, Path } from 'react-native-svg';
import type { ColorValue } from 'react-native';

export type TabIconName = 'chat' | 'history' | 'settings';

/**
 * Tab icons are line drawings on a 24 unit grid, so they stay sharp on a phone,
 * a retina desktop and in the packaged app.
 */
export function TabIcon({
  name,
  color,
  size = 22,
}: {
  name: TabIconName;
  color: ColorValue;
  size?: number;
}) {
  const stroke = color as string;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {name === 'chat' ? (
        <Path
          d="M21 14.6a3 3 0 0 1-3 3H8.4L4 20.5V5.4a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3z"
          stroke={stroke}
          strokeWidth={1.7}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : null}
      {name === 'history' ? (
        <>
          <Circle cx="12" cy="12" r="8.2" stroke={stroke} strokeWidth={1.7} />
          <Path
            d="M12 7.6V12l3.1 1.9"
            stroke={stroke}
            strokeWidth={1.7}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : null}
      {name === 'settings' ? (
        <>
          <Path
            d="M4 21v-6.4M4 10.6V3M12 21v-8.4M12 8.6V3M20 21v-4.4M20 12.6V3M1.6 14.6h4.8M9.6 8.6h4.8M17.6 16.6h4.8"
            stroke={stroke}
            strokeWidth={1.7}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : null}
    </Svg>
  );
}
