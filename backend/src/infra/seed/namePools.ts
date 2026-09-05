/**
 * Fixed name pools for synthetic patient generation (R2.5).
 *
 * These are ordinary common given names and surnames combined at random by a seeded generator. They
 * are not drawn from, derived from, or matched against any real dataset, and no combination here
 * refers to a real person. Keeping the pools as committed ASCII literals rather than a faker
 * dependency also means the generated dataset is reproducible from the seed alone, with no library
 * version able to change the output underneath us.
 */

export const FIRST_NAMES: readonly string[] = [
  'Amara', 'Nadia', 'Priya', 'Rosa', 'Ingrid', 'Lena', 'Yuki', 'Farah', 'Zoya', 'Mei',
  'Claudia', 'Anika', 'Sofia', 'Elif', 'Naomi', 'Vera', 'Daria', 'Aisha', 'Tamar', 'Lucia',
  'Marcus', 'Dmitri', 'Kwame', 'Rafael', 'Tobias', 'Hiroshi', 'Omar', 'Niall', 'Viktor', 'Andre',
  'Samir', 'Lars', 'Diego', 'Emeka', 'Jonas', 'Ravi', 'Mateo', 'Pieter', 'Hassan', 'Sven',
  'Rowan', 'Alex', 'Jordan', 'Kai', 'Noor', 'Sasha', 'Robin', 'Ari', 'Devon', 'Quinn',
];

export const LAST_NAMES: readonly string[] = [
  'Okonkwo', 'Lindqvist', 'Vargas', 'Nakamura', 'Aldridge', 'Petrov', 'Sandoval', 'Haugen',
  'Belanger', 'Moreau', 'Castellano', 'Nyberg', 'Oyelaran', 'Vandermeer', 'Kowalski', 'Ferreira',
  'Bhattacharya', 'Sinclair', 'Novotny', 'Draganov', 'Whitfield', 'Espinoza', 'Halvorsen',
  'Marchetti', 'Delacroix', 'Ashworth', 'Mbeki', 'Solberg', 'Kaminski', 'Rasmussen', 'Fontaine',
  'Varela', 'Thorne', 'Yamashita', 'Abdulrahman', 'Lindgren', 'Barrera', 'Novak', 'Ellingson',
  'Rutherford', 'Salvatierra', 'Bergstrom', 'Chaudhary', 'Ivanova', 'Mensah', 'Falconer',
  'Zielinski', 'Aguirre', 'Halloran', 'Tsvetkov',
];
