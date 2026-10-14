# Release builds drop verbose, debug and info logging; warnings and errors stay.
-assumenosideeffects class android.util.Log {
	public static int v(...);
	public static int d(...);
	public static int i(...);
}
