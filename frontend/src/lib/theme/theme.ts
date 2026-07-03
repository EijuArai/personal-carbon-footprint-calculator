import { createTheme } from "@mui/material/styles";

export const greenReputationTheme = createTheme({
  cssVariables: true,
  palette: {
    mode: "light",
    primary: {
      main: "#19733b",
      light: "#3a9257",
      dark: "#0f4b24",
      contrastText: "#f5fbf6",
    },
    secondary: {
      main: "#2f8f83",
      light: "#5da99f",
      dark: "#215f57",
      contrastText: "#f6fffd",
    },
    background: {
      default: "#eef6ef",
      paper: "#ffffff",
    },
    text: {
      primary: "#112118",
      secondary: "#4f6657",
    },
    divider: "rgba(17, 33, 24, 0.12)",
  },
  shape: {
    borderRadius: 18,
  },
  typography: {
    fontFamily: '"Manrope", "Segoe UI", sans-serif',
    h1: {
      fontSize: "clamp(2.5rem, 5vw, 4.5rem)",
      lineHeight: 1.02,
      fontWeight: 800,
      letterSpacing: "-0.04em",
    },
    h2: {
      fontSize: "clamp(1.4rem, 3vw, 2rem)",
      lineHeight: 1.1,
      fontWeight: 800,
      letterSpacing: "-0.03em",
    },
    body1: {
      fontSize: "1.05rem",
      lineHeight: 1.7,
    },
    button: {
      textTransform: "none",
      fontWeight: 700,
    },
  },
  components: {
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 999,
          paddingInline: 20,
          minHeight: 46,
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: "none",
        },
      },
    },
  },
});