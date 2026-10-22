# Release builds drop verbose, debug and info logging; warnings and errors stay.
-assumenosideeffects class android.util.Log {
	public static int v(...);
	public static int d(...);
	public static int i(...);
}

# Readium asks, through Kotlin reflection, whether a file was ever opened, only to skip closing
# it otherwise. Answering yes lets the reflection library go (see build.gradle.kts); closing a
# file that was never opened opens it and closes it again, and a failure to open is caught.
-assumenosideeffects class org.readium.r2.shared.util.LazyKt {
	boolean isLazyInitialized(kotlin.reflect.KProperty0) return true;
}
# The only class of the library that code refers to, from inside the method answered above.
-dontwarn kotlin.reflect.jvm.KCallablesJvm
